/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const axios = require('axios');

class GroheApi {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.client = axios.create({ timeout: 15000 });

		/** @type {string|null} */
		this.accessToken = null;

		/** @type {string|null} */
		this.refreshToken = null;
	}

	/**
	 * @param {string} token
	 */
	setRefreshToken(token) {
		this.refreshToken = String(token || '').replace(/\s+/g, '');
	}

	/**
	 * @param {string} token
	 */
	setAccessToken(token) {
		this.accessToken = String(token || '').replace(/\s+/g, '');
	}

	/**
	 * @returns {Promise<{accessToken: string, refreshToken: string}>}
	 */
	async refresh() {
		if (!this.refreshToken) {
			/** @type {Error & { code?: string }} */
			const err = new Error('Kein Refresh Token vorhanden');
			err.code = 'NO_REFRESH_TOKEN';
			throw err;
		}

		const rt = String(this.refreshToken).replace(/\s+/g, '');

		try {
			const resp = await this.client.post(
				'https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/refresh',
				{ refresh_token: rt },
				{ headers: { 'Content-Type': 'application/json' } }
			);

			if (!resp.data?.access_token) {
				/** @type {Error & { code?: string }} */
				const err = new Error('Keine access_token Antwort erhalten');
				err.code = 'TOKEN_RESPONSE_INVALID';
				throw err;
			}

			const accessToken = String(resp.data.access_token);
			const refreshToken = resp.data.refresh_token ? String(resp.data.refresh_token).replace(/\s+/g, '') : rt;

			this.accessToken = accessToken;
			this.refreshToken = refreshToken;

			return { accessToken, refreshToken };
		} catch (e) {
			const status = e?.response?.status;
			const details = e?.response?.data ? JSON.stringify(e.response.data) : e.message;

			this.adapter.log.warn(`Refresh failed (${status || 'no-status'}): ${details}`);

			if (status === 400 || status === 401) {
				/** @type {Error & { code?: string }} */
				const err = new Error('Refresh Token ungültig oder abgelaufen');
				err.code = 'INVALID_REFRESH_TOKEN';
				throw err;
			}

			/** @type {Error & { code?: string }} */
			const err = new Error(`Token Refresh fehlgeschlagen: ${e.message}`);
			err.code = 'TOKEN_REFRESH_FAILED';
			throw err;
		}
	}

	/**
	 * @param {import('axios').AxiosRequestConfig} config
	 * @param {boolean} [retry=true]
	 */
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
