'use strict';

const utils = require('@iobroker/adapter-core');
const GroheApi = require('./lib/api');
const GroheLogin = require('./lib/login');

/**
 * @typedef {Error & { code?: string }} ErrorWithCode
 */

/**
 * @param {unknown} err
 * @returns {err is ErrorWithCode}
 */
function hasCode(err) {
	return typeof err === 'object' && err !== null && 'code' in err;
}

class GroheSmarthome extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	constructor(options) {
		super({ ...options, name: 'grohe-smarthome' });

		/** @type {GroheApi|null} */
		this.api = null;

		/** @type {NodeJS.Timeout|null} */
		this.pollTimer = null;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async onReady() {
		await this.setState('info.connection', { val: false, ack: true });

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
		await this.ensureState('info.loginStep', {
			name: 'Login Schritt',
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		});

		await this.setState('info.tokenValid', { val: false, ack: true });
		await this.setState('info.tokenError', { val: '', ack: true });
		await this.setState('info.loginStep', { val: '', ack: true });

		try {
			this.api = new GroheApi(this);

			// encryptedNative -> config values are plaintext here
			const email = (this.config.email || '').trim();
			const password = this.config.password || '';
			const savedRefresh = String(this.config.refreshToken || '').replace(/\s+/g, '');
			const debugLogin = !!this.config.debugLogin;

			// Step 1: try refresh token if present
			if (savedRefresh) {
				await this.setState('info.loginStep', { val: 'refresh_with_saved_token', ack: true });
				this.api.setRefreshToken(savedRefresh);

				try {
					const { refreshToken } = await this.api.refresh();
					await this.persistRefreshTokenIfChanged(refreshToken);
					await this.setState('info.tokenValid', { val: true, ack: true });
					await this.setState('info.tokenError', { val: '', ack: true });
				} catch (e) {
					this.log.warn(`Refresh mit gespeichertem Token fehlgeschlagen, versuche Web-Login: ${e.message}`);
				}
			}

			// Step 2: full web login
			if (!this.api.accessToken) {
				if (!email || !password) {
					throw new Error(
						'Bitte E-Mail/Passwort in den Adapter-Einstellungen setzen (für automatischen Login).',
					);
				}

				await this.setState('info.loginStep', { val: 'web_login_start', ack: true });
				const login = new GroheLogin(this, { debug: debugLogin });

				const tokens = await login.login(email, password);

				await this.setState('info.loginStep', { val: 'web_login_tokens_received', ack: true });

				this.api.setAccessToken(tokens.access_token);
				this.api.setRefreshToken(tokens.refresh_token);

				await this.persistRefreshTokenIfChanged(tokens.refresh_token);

				// Option: clear password after success (safer)
				if (!this.config.keepPassword) {
					await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
						native: {
							...this.config,
							password: '',
						},
					});
					this.log.info(
						'Passwort wurde nach erfolgreichem Login aus der Config entfernt (keepPassword=false).',
					);
				}

				await this.setState('info.tokenValid', { val: true, ack: true });
				await this.setState('info.tokenError', { val: '', ack: true });
			}

			await this.setState('info.loginStep', { val: 'ready', ack: true });
			await this.setState('info.connection', { val: true, ack: true });

			await this.pollDevices();
			const interval = Math.max(60, Number(this.config.pollInterval) || 300);

			this.pollTimer = setInterval(() => {
				this.pollDevices().catch(err => this.log.error(err.message));
			}, interval * 1000);

			this.log.info(`Polling aktiv: alle ${interval}s`);
		} catch (err) {
			await this.handleInitError(err);
		}
	}

	async pollDevices() {
		if (!this.api) {
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
			await this.setState('info.connection', { val: false, ack: true });
			this.log.error(`pollDevices fehlgeschlagen: ${err.message}`);
		}
	}

	async persistRefreshTokenIfChanged(newToken) {
		const nt = String(newToken || '').replace(/\s+/g, '');
		if (!nt) {
			return;
		}

		const current = String(this.config.refreshToken || '').replace(/\s+/g, '');
		if (current === nt) {
			return;
		}

		await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
			native: {
				...this.config,
				refreshToken: nt,
			},
		});

		this.log.info('Refresh Token gespeichert/aktualisiert');
	}

	/* ===================== Device mapping ===================== */

	async updateDevice(dev) {
		const id = dev.appliance_id || dev.id || dev.device_id;
		if (!id) {
			this.log.debug('Device ohne appliance_id erhalten – übersprungen');
			return;
		}

		switch (dev.appliance_type) {
			case 'SENSE':
				return this.updateSense(dev);
			case 'SENSE_GUARD':
				return this.updateSenseGuard(dev);
			case 'BLUE_HOME':
			case 'BLUE_PRO':
				return this.updateBlue(dev);
			default:
				await this.ensureDevice(id, dev.name || 'Grohe Device', dev.appliance_type || 'UNKNOWN');
				await this.writeRawLatest(id, dev.data_latest || {});
				this.log.debug(`Unbekannter Gerätetyp: ${dev.appliance_type}`);
		}
	}

	async updateSense(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};
		await this.ensureDevice(id, dev.name || 'Grohe Sense', 'SENSE');

		await this.createNumber(id, 'temperature', 'Temperatur', 'value.temperature', d.temperature);
		await this.createNumber(id, 'humidity', 'Luftfeuchte', 'value.humidity', d.humidity);
		await this.createBoolean(id, 'leakDetected', 'Wasser erkannt', 'indicator.alarm', d.leak_detected);
		await this.createNumber(id, 'battery', 'Batterie', 'value.battery', d.battery_level);

		await this.createNumber(id, 'signal', 'Signal', 'value.signal', d.signal_strength);
		await this.createNumber(id, 'rssi', 'RSSI', 'value.signal', d.rssi);

		await this.writeRawLatest(id, d);
	}

	async updateSenseGuard(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};
		await this.ensureDevice(id, dev.name || 'Grohe Sense Guard', 'SENSE_GUARD');

		await this.createNumber(id, 'flowRate', 'Durchfluss', 'value.flow', d.flow_rate);
		await this.createNumber(id, 'pressure', 'Druck', 'value.pressure', d.pressure);
		await this.createBoolean(id, 'leakDetected', 'Leck erkannt', 'indicator.alarm', d.leak_detected);
		await this.createBoolean(id, 'valveOpen', 'Ventil offen', 'indicator.open', d.valve_open);

		// Backwards-compatible switch (optional)
		await this.createWritableBoolean(id, 'setValve', 'Ventil (Switch)', 'switch');

		// NEW: explicit open/close buttons
		await this.ensureChannel(`${id}.controls`, 'Controls');
		await this.createWritableBoolean(`${id}.controls`, 'valveOpen', 'Ventil öffnen', 'button');
		await this.createWritableBoolean(`${id}.controls`, 'valveClose', 'Ventil schließen', 'button');

		await this.writeRawLatest(id, d);
	}

	async updateBlue(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};
		await this.ensureDevice(id, dev.name || 'Grohe Blue', dev.appliance_type);

		await this.createNumber(id, 'co2Level', 'CO₂ Füllstand', 'value.percent', d.co2_level);
		await this.createNumber(id, 'filterRemaining', 'Filter Restlaufzeit', 'value.percent', d.filter_remaining);
		await this.createNumber(id, 'waterTemperature', 'Wassertemperatur', 'value.temperature', d.temperature);

		await this.ensureChannel(`${id}.controls`, 'Controls');
		await this.createNumber(`${id}.controls`, 'dispenseType', 'Zapf-Typ (int)', 'level', 0, true);
		await this.createNumber(`${id}.controls`, 'dispenseAmountMl', 'Menge (ml)', 'level', 250, true);
		await this.createWritableBoolean(`${id}.controls`, 'dispenseTrigger', 'Zapfen auslösen', 'button');

		await this.writeRawLatest(id, d);
	}

	/* ===================== Writes ===================== */

	async onStateChange(id, state) {
		if (!state || state.ack || !this.api) {
			return;
		}

		try {
			// Sense Guard: legacy switch
			if (id.endsWith('.setValve')) {
				const deviceId = id.split('.').slice(-2, -1)[0];
				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/valve`,
					data: { open: !!state.val },
				});
				await this.setState(id, { ack: true });
				return;
			}

			// Sense Guard: open button
			if (id.endsWith('.controls.valveOpen')) {
				if (!state.val) {
					await this.setState(id, { ack: true });
					return;
				}
				const parts = id.split('.');
				const deviceId = parts[parts.length - 3];
				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/valve`,
					data: { open: true },
				});
				// reset button
				await this.setState(id, { val: false, ack: true });
				return;
			}

			// Sense Guard: close button
			if (id.endsWith('.controls.valveClose')) {
				if (!state.val) {
					await this.setState(id, { ack: true });
					return;
				}
				const parts = id.split('.');
				const deviceId = parts[parts.length - 3];
				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/valve`,
					data: { open: false },
				});
				// reset button
				await this.setState(id, { val: false, ack: true });
				return;
			}

			// Blue: dispense trigger button
			if (id.endsWith('.controls.dispenseTrigger')) {
				if (!state.val) {
					await this.setState(id, { ack: true });
					return;
				}
				const parts = id.split('.');
				const deviceId = parts[parts.length - 3];

				const typeState = await this.getStateAsync(`${deviceId}.controls.dispenseType`);
				const mlState = await this.getStateAsync(`${deviceId}.controls.dispenseAmountMl`);

				const type = Number(typeState?.val ?? 0);
				const amountMl = Number(mlState?.val ?? 250);

				await this.api.request({
					method: 'POST',
					url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/dispense`,
					data: { type, amountMl },
				});

				await this.setState(id, { val: false, ack: true });
				return;
			}
		} catch (err) {
			this.log.error(`Aktion fehlgeschlagen (${id}): ${err.message}`);
		}
	}

	/* ===================== Object helpers (no deprecated create*) ===================== */

	async ensureDevice(id, name, type) {
		const obj = await this.getObjectAsync(id);
		if (!obj) {
			await this.setObject(id, {
				type: 'device',
				common: { name: `${name} (${type})` },
				native: { type },
			});
		}
	}

	async ensureChannel(id, name) {
		const obj = await this.getObjectAsync(id);
		if (!obj) {
			await this.setObject(id, {
				type: 'channel',
				common: { name },
				native: {},
			});
		}
	}

	async ensureState(id, common) {
		const obj = await this.getObjectAsync(id);
		if (!obj) {
			await this.setObject(id, { type: 'state', common, native: {} });
		}
	}

	async createNumber(devId, name, label, role, value, writable = false) {
		const sid = `${devId}.${name}`;
		await this.ensureState(sid, { name: label, type: 'number', role, read: true, write: !!writable });
		if (value !== undefined) {
			await this.setState(sid, { val: value, ack: true });
		}
	}

	async createBoolean(devId, name, label, role, value) {
		const sid = `${devId}.${name}`;
		await this.ensureState(sid, { name: label, type: 'boolean', role, read: true, write: false });
		if (value !== undefined) {
			await this.setState(sid, { val: !!value, ack: true });
		}
	}

	async createWritableBoolean(devId, name, label, role) {
		const sid = `${devId}.${name}`;
		await this.ensureState(sid, { name: label, type: 'boolean', role, read: true, write: true });
	}

	async writeRawLatest(devId, dataLatest) {
		if (!dataLatest || typeof dataLatest !== 'object') {
			return;
		}

		await this.ensureChannel(`${devId}.raw`, 'Raw');

		for (const [k, v] of Object.entries(dataLatest)) {
			if (v === null || v === undefined) {
				continue;
			}

			const t = typeof v;
			if (t === 'number') {
				await this.createNumber(`${devId}.raw`, k, k, 'value', v, false);
			} else if (t === 'boolean') {
				const sid = `${devId}.raw.${k}`;
				await this.ensureState(sid, { name: k, type: 'boolean', role: 'indicator', read: true, write: false });
				await this.setState(sid, { val: !!v, ack: true });
			} else if (t === 'string') {
				const sid = `${devId}.raw.${k}`;
				await this.ensureState(sid, { name: k, type: 'string', role: 'text', read: true, write: false });
				await this.setState(sid, { val: v, ack: true });
			}
		}
	}

	async handleInitError(err) {
		const code = (() => {
			const e = err;
			const axiosStatus = e?.response?.status;
			const axiosBody = e?.response?.data;
			if (axiosStatus) {
				return `HTTP_${axiosStatus}: ${typeof axiosBody === 'string' ? axiosBody : JSON.stringify(axiosBody)}`;
			}
			if (hasCode(e) && typeof e.code === 'string') {
				return e.code;
			}
			if (e instanceof Error) {
				return e.message;
			}
			return String(e);
		})();
		await this.setState('info.connection', { val: false, ack: true });
		await this.setState('info.tokenValid', { val: false, ack: true });
		await this.setState('info.tokenError', { val: String(code), ack: true });
		await this.setState('info.loginStep', { val: 'error', ack: true });

		this.log.error(`Initialisierung fehlgeschlagen: ${String(code)}`);
	}

	onUnload(callback) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}
			this.api = null;
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new GroheSmarthome(options);
} else {
	new GroheSmarthome();
}
