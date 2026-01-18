'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const GroheApi = require('./lib/api');

// Load your modules here, e.g.:
// const fs = require('fs');

class GroheSmarthome extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'grohe_smarthome',
		});

		this.api = null;
		this.pollTimer = null;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async onReady() {
		if (!this.config.email || !this.config.password) {
			this.log.error('Bitte Grohe Cloud Zugangsdaten konfigurieren!');
			return;
		}

		this.setState('info.connection', false, true);
		try {
			this.api = new GroheApi(this);

			await this.api.login(this.config.email, this.decrypt(this.config.password.replace(/^enc:/, '')));

			this.setState('info.connection', true, true);

			await this.pollDevices();

			this.pollTimer = setInterval(() => this.pollDevices(), (this.config.pollInterval || 300) * 1000);
		} catch (err) {
			this.log.error(`Login fehlgeschlagen: ${err.message}`);
			this.setState('info.connection', false, true);
		}
	}

	async pollDevices() {
		if (!this.api) {
			this.log.warn('pollDevices aufgerufen, aber API ist nicht initialisiert');
			this.setState('info.connection', false, true);
			return;
		}

		try {
			const resp = await this.api.request({
				method: 'GET',
				url: 'https://api.grohe-iot.com/v1/devices',
			});

			this.setState('info.connection', true, true);

			for (const dev of resp.data.devices || []) {
				await this.updateDevice(dev);
			}
		} catch (err) {
			this.setState('info.connection', false, true);
			this.log.error(`pollDevices fehlgeschlagen: ${err.message}`);
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
				this.log.warn(`Unbekannter Gerätetyp: ${dev.appliance_type}`);
		}
	}

	/* ===================== SENSE ===================== */

	async updateSense(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.createDevice(id, dev.name, 'Grohe Sense');

		await this.createState(id, 'temperature', 'number', 'value.temperature', d.temperature);
		await this.createState(id, 'humidity', 'number', 'value.humidity', d.humidity);
		await this.createState(id, 'leakDetected', 'boolean', 'indicator.alarm', d.leak_detected);
		await this.createState(id, 'battery', 'number', 'value.battery', d.battery_level);
	}

	/* ================== SENSE GUARD ================== */

	async updateSenseGuard(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.createDevice(id, dev.name, 'Grohe Sense Guard');

		await this.createState(id, 'flowRate', 'number', 'value.flow', d.flow_rate);
		await this.createState(id, 'pressure', 'number', 'value.pressure', d.pressure);
		await this.createState(id, 'leakDetected', 'boolean', 'indicator.alarm', d.leak_detected);
		await this.createState(id, 'valveOpen', 'boolean', 'switch', d.valve_open);

		await this.createWritableState(id, 'setValve', 'boolean', 'switch');
	}

	/* ====================== BLUE ===================== */

	async updateBlue(dev) {
		const id = dev.appliance_id;
		const d = dev.data_latest || {};

		await this.createDevice(id, dev.name, 'Grohe Blue');

		await this.createState(id, 'co2Level', 'number', 'value.percent', d.co2_level);
		await this.createState(id, 'filterRemaining', 'number', 'value.percent', d.filter_remaining);
		await this.createState(id, 'waterTemperature', 'number', 'value.temperature', d.temperature);

		await this.createWritableState(id, 'dispenseWater', 'string', 'control');
	}

	/* =================== HELPERS ===================== */

	async createDevice(id, name, type) {
		await this.setObjectNotExistsAsync(id, {
			type: 'device',
			common: { name: `${name} (${type})` },
			native: {},
		});
	}

	async createState(deviceId, name, type, role, value) {
		const path = `${deviceId}.${name}`;
		await this.setObjectNotExistsAsync(path, {
			type: 'state',
			common: { name, type, role, read: true, write: false },
			native: {},
		});
		if (value !== undefined) {
			this.setState(path, { val: value, ack: true });
		}
	}

	async createWritableState(deviceId, name, type, role) {
		await this.setObjectNotExistsAsync(`${deviceId}.${name}`, {
			type: 'state',
			common: { name, type, role, read: true, write: true },
			native: {},
		});
	}

	/* ================== ACTIONS ====================== */

	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}

		if (!this.api) {
			this.log.warn(`API nicht initialisiert – Aktion ignoriert (${id})`);
			return;
		}

		if (id.endsWith('.setValve')) {
			const deviceId = id.split('.').slice(-2, -1)[0];
			await this.api.request({
				method: 'POST',
				url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/valve`,
				data: { open: state.val },
			});
			this.setState(id, { ack: true });
		}

		if (id.endsWith('.dispenseWater')) {
			const deviceId = id.split('.').slice(-2, -1)[0];
			const [type, amount] = state.val.split(':');

			await this.api.request({
				method: 'POST',
				url: `https://api.grohe-iot.com/v1/devices/${deviceId}/actions/dispense`,
				data: {
					type: Number(type),
					amountMl: Number(amount),
				},
			});

			this.setState(id, { ack: true });
		}
	}

	onUnload(callback) {
		this.api = null;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
		}
		callback();
	}
}

module.exports = options => new GroheSmarthome(options);
