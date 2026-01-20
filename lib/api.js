/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const axios = require('axios');
/**
 * @typedef {Error & { code?: string }} ErrorWithCode
 */
class GroheApi {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter ioBroker adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.client = axios.create({
			timeout: 15000,
			headers: { 'Content-Type': 'application/json' },
		});

		this.accessToken = null;

		this.refreshToken = null;
	}

	setRefreshToken(token) {
		this.refreshToken = token;
	}

	async refresh() {
		if (!this.refreshToken) {
			/** @type {ErrorWithCode} */
			const err = new Error('Kein Refresh Token vorhanden');
			err.code = 'NO_REFRESH_TOKEN';
			throw err;
		}

		try {
			const resp = await this.client.post('https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/refresh', {
				refresh_token: this.refreshToken,
			});

			if (!resp.data?.access_token) {
				/** @type {ErrorWithCode} */
				const err = new Error('Keine access_token Antwort von Grohe erhalten');
				err.code = 'TOKEN_RESPONSE_INVALID';
				throw err;
			}

			this.accessToken = resp.data.access_token;

			if (resp.data.refresh_token) {
				this.refreshToken = resp.data.refresh_token;
			}

			return { accessToken: this.accessToken, refreshToken: this.refreshToken };
		} catch (e) {
			const status = e?.response?.status;

			if (status === 400 || status === 401) {
				/** @type {ErrorWithCode} */
				const err = new Error('Refresh Token ungültig oder abgelaufen');
				err.code = 'INVALID_REFRESH_TOKEN';
				throw err;
			}
			/** @type {ErrorWithCode} */
			const err = new Error(`Token Refresh fehlgeschlagen: ${e.message}`);
			err.code = 'TOKEN_REFRESH_FAILED';
			throw err;
		}
	}

	async request(config, retry = true) {
		if (!this.accessToken) {
			await this.refresh();
		}

		config.headers = { ...(config.headers || {}), Authorization: `Bearer ${this.accessToken}` };

		try {
			return await this.client.request(config);
		} catch (e) {
			if (e?.response?.status === 401 && retry) {
				await this.refresh();
				return this.request(config, false);
			}
			throw e;
		}
	}
}

module.exports = GroheApi;
