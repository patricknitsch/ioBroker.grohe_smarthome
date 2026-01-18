'use strict';

const axios = require('axios');
/**
 * GroheApi kommuniziert mit der Grohe Cloud API,
 * verwaltet Authentifizierung, Token-Refresh und HTTP-Requests.
 */
class GroheApi {
	/**
	 * Erzeugt eine neue Instanz der API mit Adapter-Referenz.
	 *
	 * @param {object} adapter - ioBroker Adapter Instanz für Logging und Encryption
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.client = axios.create({ timeout: 15000 });
		this.accessToken = null;
		this.refreshToken = null;
	}

	/**
	 * @param {string} email
	 * @param {string} password
	 */
	async login(email, password) {
		try {
			const resp = await this.client.post('https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/login', {
				email,
				password,
			});

			this.accessToken = resp.data.access_token;
			this.refreshToken = resp.data.refresh_token;
			this.adapter.log.info('Grohe Cloud Login erfolgreich');
		} catch (err) {
			this.adapter.log.error(`Grohe Cloud Login fehlgeschlagen: ${err.message}`);
			throw err; // Fehler weiterwerfen, damit caller reagieren kann
		}
	}

	/**
	 *
	 */
	async refresh() {
		this.adapter.log.info('Grohe Token-Refresh…');

		const resp = await this.client.post('https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/token', {
			grant_type: 'refresh_token',
			refresh_token: this.refreshToken,
		});

		this.accessToken = resp.data.access_token;
		this.refreshToken = resp.data.refresh_token;
	}

	/**
	 * @param {axios.AxiosRequestConfig<any>} config
	 * @param retry
	 */
	async request(config, retry = true) {
		try {
			config.headers = config.headers || {};
			config.headers.Authorization = `Bearer ${this.accessToken}`;
			return await this.client.request(config);
		} catch (err) {
			if (err.response?.status === 401 && retry) {
				await this.refresh();
				return this.request(config, false);
			}
			throw err;
		}
	}
}

module.exports = GroheApi;
