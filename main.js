/* eslint-disable jsdoc/require-param */
'use strict';

/*
 * Grohe Smarthome ioBroker Adapter (Refresh Token only)
 */

const utils = require('@iobroker/adapter-core');
const GroheApi = require('./lib/api');

function hasCode(err) {
	return typeof err === 'object' && err !== null && 'code' in err;
}

class GroheSmarthome extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] adapter options
	 */
	constructor(options) {
		super({ ...options, name: 'grohe-smarthome' });

		this.api = null;

		this.pollTimer = null;

		this.tokenInvalid = false;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * onReady
	 */
	async onReady() {
		await this.setState('info.connection', { val: false, ack: true });

		// Info states for token status
		await this.ensureState('info.tokenValid', {
			name: 'Token gültig',
			type: 'boolean',
			role: 'indicator.working',
			read: true,
			write: false,
		});
		await this.ensureState('info.tokenError', {
			name: 'Token Fehler',
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		});

		await this.setState('info.tokenValid', { val: false, ack: true });
		await this.setState('info.tokenError', { val: '', ack: true });

		try {
			this.log.info('Grohe Smarthome Adapter startet');

			if (!this.config.refreshToken) {
				throw Object.assign(new Error('Kein Refresh Token konfiguriert'), { code: 'NO_REFRESH_TOKEN' });
			}

			const refreshToken = this.config.refreshToken; // bereits Klartext

			this.api = new GroheApi(this);
			this.api.setRefreshToken(refreshToken);

			// Initialer Token-Check
			await this.refreshAndPersistToken();

			await this.setState('info.connection', { val: true, ack: true });
			await this.setState('info.tokenValid', { val: true, ack: true });
			await this.setState('info.tokenError', { val: '', ack: true });

			await this.pollDevices();

			const interval = Math.max(60, Number(this.config.pollInterval) || 300);
			this.pollTimer = setInterval(() => {
				this.pollDevices().catch(err => this.log.error(err.message));
			}, interval * 1000);

			this.log.info(`Polling aktiv: alle ${interval}s`);
		} catch (err) {
			await this.handleTokenOrInitError(err);
		}
	}

	/**
	 * Refresh token + persist rotated refresh_token into config (encryptedNative)
	 */
	async refreshAndPersistToken() {
		if (!this.api) {
			return;
		}

		const before = this.api.refreshToken;
		await this.api.refresh();
		const after = this.api.refreshToken;

		// persist rotated refresh token
		if (after && before && after !== before) {
			await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
				native: {
					...this.config,
					refreshToken: after,
				},
			});
			this.log.info('Refresh Token rotiert und gespeichert');
		}
	}

	async pollDevices() {
		if (!this.api) {
			this.log.warn('pollDevices: API nicht initialisiert');
			return;
		}

		if (this.tokenInvalid) {
			// token invalid => do not spam API
			return;
		}

		try {
			const resp = await this.api.request({
				method: 'GET',
				url: 'https://api.grohe-iot.com/v1/devices',
			});

			await this.setState('info.connection', { val: true, ack: true });

			for (const dev of resp.data?.devices || []) {
				await this.updateDevice(dev);
			}
		} catch (err) {
			this.log.error(`pollDevices fehlgeschlagen: ${err.message}`);
			await this.setState('info.connection', { val: false, ack: true });
		}
	}

	async updateDevice(dev) {
		switch (dev.appliance_type) {
			case 'SENSE':
				return this.updateSense(dev);
			case 'SENSE_GUARD':
				return this.updateSenseGuard(dev);
			case 'BLUE_HOME':
			case 'BLUE_PRO':
				return this.updateBlue(dev);
			default:
				this.log.debug(`Unbekannter Gerätetyp: ${dev.appliance_type}`);
		}
	}

	/* ===================== SENSE ===================== */

	async updateSense(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.ensureDevice(id, dev.name || 'Grohe Sense', 'SENSE');

		// Typical Sense values (if present)
		await this.createNumber(id, 'temperature', 'Temperatur', 'value.temperature', d.temperature);
		await this.createNumber(id, 'humidity', 'Luftfeuchte', 'value.humidity', d.humidity);
		await this.createBoolean(id, 'leakDetected', 'Wasser erkannt', 'indicator.alarm', d.leak_detected);
		await this.createNumber(id, 'battery', 'Batterie', 'value.battery', d.battery_level);

		// Optional values (only if present)
		if (d.rssi !== undefined) {
			await this.createNumber(id, 'rssi', 'Signal (RSSI)', 'value', d.rssi);
		}
		if (d.firmware_version !== undefined) {
			await this.createString(id, 'firmware', 'Firmware', 'info.firmware', String(d.firmware_version));
		}
		if (dev.online !== undefined) {
			await this.createBoolean(id, 'online', 'Online', 'indicator.connected', !!dev.online);
		}
	}

	/* ================== SENSE GUARD ================== */

	async updateSenseGuard(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.ensureDevice(id, dev.name || 'Grohe Sense Guard', 'SENSE_GUARD');

		await this.createNumber(id, 'flowRate', 'Durchfluss', 'value.flow', d.flow_rate);
		await this.createNumber(id, 'pressure', 'Druck', 'value.pressure', d.pressure);
		await this.createBoolean(id, 'leakDetected', 'Leck erkannt', 'indicator.alarm', d.leak_detected);
		await this.createBoolean(id, 'valveOpen', 'Ventil offen', 'indicator.open', d.valve_open);

		if (d.temperature !== undefined) {
			await this.createNumber(id, 'temperature', 'Temperatur', 'value.temperature', d.temperature);
		}
		if (d.battery_level !== undefined) {
			await this.createNumber(id, 'battery', 'Batterie', 'value.battery', d.battery_level);
		}
		if (dev.online !== undefined) {
			await this.createBoolean(id, 'online', 'Online', 'indicator.connected', !!dev.online);
		}

		// Control
		await this.createWritableBoolean(id, 'setValve', 'Ventil schalten', 'switch');
	}

	/* ====================== BLUE ===================== */

	async updateBlue(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.ensureDevice(id, dev.name || 'Grohe Blue', dev.appliance_type);

		await this.createNumber(id, 'co2Level', 'CO₂ Füllstand', 'value.percent', d.co2_level);
		await this.createNumber(id, 'filterRemaining', 'Filter Restlaufzeit', 'value.percent', d.filter_remaining);
		await this.createNumber(id, 'waterTemperature', 'Wassertemperatur', 'value.temperature', d.temperature);

		if (d.error_code !== undefined) {
			await this.createNumber(id, 'errorCode', 'Fehlercode', 'value', d.error_code);
		}
		if (d.firmware_version !== undefined) {
			await this.createString(id, 'firmware', 'Firmware', 'info.firmware', String(d.firmware_version));
		}
		if (dev.online !== undefined) {
			await this.createBoolean(id, 'online', 'Online', 'indicator.connected', !!dev.online);
		}

		// Control: "type:amountMl" (e.g. "2:250")
		await this.createWritableString(id, 'dispenseWater', 'Wasser zapfen (type:ml)', 'control');
	}

	/* =================== ACTIONS ====================== */

	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}

		if (!this.api) {
			this.log.warn(`API nicht initialisiert – Aktion ignoriert (${id})`);
			return;
		}
		if (this.tokenInvalid) {
			this.log.warn(`Token ungültig – Aktion ignoriert (${id})`);
			return;
		}

		try {
			if (id.endsWith('.setValve')) {
				const deviceId = id.split('.').slice(-2, -1)[0];
				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/valve`,
					data: { open: state.val },
				});

				await this.setState(id, { ack: true });
				return;
			}

			if (id.endsWith('.dispenseWater')) {
				const deviceId = id.split('.').slice(-2, -1)[0];
				const [type, amount] = String(state.val).split(':');

				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/dispense`,
					data: {
						type: Number(type),
						amountMl: Number(amount),
					},
				});

				await this.setState(id, { ack: true });
				return;
			}

			this.log.debug(`Unhandled stateChange: ${id}`);
		} catch (err) {
			this.log.error(`Aktion fehlgeschlagen (${id}): ${err.message}`);
		}
	}

	/* =================== ADMIN MESSAGE ===================== */

	onMessage(obj) {
		if (!obj || !obj.command) {
			return;
		}

		if (obj.command === 'tokenHelp') {
			// TODO: change to your repo / docs
			const url = 'https://github.com/DEIN_GITHUB_USER/DEIN_REPO#token-beschaffen';

			if (obj.callback) {
				this.sendTo(obj.from, obj.command, { openUrl: url, window: '_blank' }, obj.callback);
			}
		}
	}

	/* =================== OBJECT HELPERS ===================== */

	async ensureDevice(id, name, type) {
		const obj = await this.getObjectAsync(id);
		if (!obj) {
			await this.setObjectAsync(id, {
				type: 'device',
				common: { name: `${name} (${type})` },
				native: { type },
			});
		}
	}

	async ensureState(id, common) {
		const obj = await this.getObjectAsync(id);
		if (!obj) {
			await this.setObjectAsync(id, {
				type: 'state',
				common,
				native: {},
			});
		}
	}

	/**
	 * Create / update number state
	 */
	async createNumber(devId, name, label, role, value) {
		const id = `${devId}.${name}`;
		await this.ensureState(id, { name: label, type: 'number', role, read: true, write: false });
		if (value !== undefined) {
			await this.setState(id, { val: value, ack: true });
		}
	}

	async createBoolean(devId, name, label, role, value) {
		const id = `${devId}.${name}`;
		await this.ensureState(id, { name: label, type: 'boolean', role, read: true, write: false });
		if (value !== undefined) {
			await this.setState(id, { val: value, ack: true });
		}
	}

	async createString(devId, name, label, role, value) {
		const id = `${devId}.${name}`;
		await this.ensureState(id, { name: label, type: 'string', role, read: true, write: false });
		if (value !== undefined) {
			await this.setState(id, { val: value, ack: true });
		}
	}

	async createWritableBoolean(devId, name, label, role) {
		const id = `${devId}.${name}`;
		await this.ensureState(id, { name: label, type: 'boolean', role, read: true, write: true });
	}

	async createWritableString(devId, name, label, role) {
		const id = `${devId}.${name}`;
		await this.ensureState(id, { name: label, type: 'string', role, read: true, write: true });
	}

	/* =================== ERROR HANDLING ===================== */

	async handleTokenOrInitError(err) {
		const code =
			hasCode(err) && typeof err.code === 'string' ? err.code : err instanceof Error ? err.message : String(err);

		await this.setState('info.connection', { val: false, ack: true });
		await this.setState('info.tokenValid', { val: false, ack: true });
		await this.setState('info.tokenError', { val: String(code), ack: true });

		if (String(code) === 'INVALID_REFRESH_TOKEN') {
			this.tokenInvalid = true;

			this.log.error('Refresh Token ungültig/abgelaufen. Bitte Token neu setzen (Admin → Token erneuern).');

			// stop polling to avoid request spam
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
			return;
		}

		this.log.error(`Initialisierung fehlgeschlagen: ${String(code)}`);
	}

	onUnload(callback) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
			this.api = null;
			callback();
		} catch {
			callback();
		}
	}
}

// ioBroker adapter entry
if (require.main !== module) {
	module.exports = options => new GroheSmarthome(options);
} else {
	new GroheSmarthome();
}
