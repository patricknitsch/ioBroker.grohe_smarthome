'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

function toAbsUrl(base, maybeRelative) {
	if (!maybeRelative) {
		return null;
	}
	if (maybeRelative.startsWith('http://') || maybeRelative.startsWith('https://')) {
		return maybeRelative;
	}
	return new URL(maybeRelative, base).toString();
}

function decodeHtmlEntities(s) {
	return String(s || '').replace(/&amp;/g, '&');
}

function safeHostPath(u) {
	try {
		const x = new URL(u);
		return `${x.host}${x.pathname}`;
	} catch {
		return String(u || '').slice(0, 80);
	}
}

function parseOndusLocation(location) {
	const u = new URL(location.replace(/^ondus:\/\//, 'https://'));
	return { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
}

function clip(s, n = 500) {
	const x = typeof s === 'string' ? s : JSON.stringify(s);
	if (!x) {
		return '';
	}
	return x.length > n ? `${x.slice(0, n)}…` : x;
}

class GroheLogin {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
	 * @param {{ debug?: boolean }} [opts]
	 */
	constructor(adapter, opts) {
		this.adapter = adapter;
		this.debug = !!opts?.debug;

		this.jar = new CookieJar();
		this.client = wrapper(
			axios.create({
				timeout: 25000,
				maxRedirects: 0,
				validateStatus: s => s >= 200 && s < 400,
				jar: this.jar,
				withCredentials: true,
			}),
		);
	}

	_logDebug(msg) {
		if (this.debug) {
			this.adapter.log.info(`[login-debug] ${msg}`);
		} else {
			this.adapter.log.debug(`[login] ${msg}`);
		}
	}

	_detectKnownHtmlErrors(html) {
		if (!html) {
			return null;
		}
		if (html.includes('Restart login cookie not found')) {
			return 'RESTART_COOKIE_NOT_FOUND';
		}
		if (html.includes("We're sorry")) {
			return 'KEYCLOAK_SORRY_PAGE';
		}
		if (html.includes('Invalid username or password')) {
			return 'INVALID_CREDENTIALS';
		}
		if (html.toLowerCase().includes('otp') || html.toLowerCase().includes('two-factor')) {
			return 'MFA_REQUIRED';
		}
		return null;
	}

	async _getAuthPage() {
		const startUrl = 'https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/login';

		this._logDebug(`GET start ${safeHostPath(startUrl)}`);
		const startResp = await this.client.get(startUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });

		this._logDebug(`start status=${startResp.status} hasLocation=${!!startResp.headers.location}`);
		if (startResp.status !== 302 || !startResp.headers.location) {
			throw new Error(`Unerwartete Start-Antwort (${startResp.status}), kein Redirect erhalten`);
		}

		const authUrl = toAbsUrl(startUrl, startResp.headers.location);
		this._logDebug(`GET auth ${safeHostPath(authUrl)} (query hidden)`);
		const authResp = await this.client.get(authUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });

		this._logDebug(
			`auth status=${authResp.status} contentType=${String(authResp.headers['content-type'] || '').split(';')[0]}`,
		);

		if (authResp.status !== 200 || typeof authResp.data !== 'string') {
			throw new Error(`Keycloak Auth-Seite unerwartet (${authResp.status})`);
		}

		const err = this._detectKnownHtmlErrors(authResp.data);
		if (err) {
			throw new Error(`Keycloak Fehlerseite bereits beim GET auth: ${err}`);
		}

		return { authUrl, authHtml: authResp.data };
	}

	_parseLoginForm(authUrl, authHtml) {
		const $ = cheerio.load(authHtml);
		const form = $('form').first();

		const actionRaw = form.attr('action');
		if (!actionRaw) {
			throw new Error('Login-Form action nicht gefunden');
		}

		const action = decodeHtmlEntities(actionRaw);
		const actionUrl = toAbsUrl(authUrl, action);

		const fields = {};
		form.find('input').each((_, el) => {
			const name = $(el).attr('name');
			if (!name) {
				return;
			}
			fields[name] = $(el).attr('value') ?? '';
		});

		let passField = null;
		form.find('input').each((_, el) => {
			const type = ($(el).attr('type') || '').toLowerCase();
			const name = $(el).attr('name');
			if (!name) {
				return;
			}
			if (!passField && type === 'password') {
				passField = name;
			}
		});

		let userField = null;
		for (const cand of ['username', 'email', 'usernameOrEmail']) {
			if (cand in fields) {
				userField = cand;
				break;
			}
		}
		if (!userField) {
			const firstText = form.find('input[type="text"], input[type="email"]').first();
			userField = firstText.attr('name') || 'username';
		}
		if (!passField) {
			passField = 'password';
		}

		if (!('credentialId' in fields)) {
			fields.credentialId = '';
		}

		this._logDebug(
			`form action=${safeHostPath(actionUrl)} fields=${Object.keys(fields).length} userField=${userField} passField=${passField}`,
		);

		return { actionUrl, fields, userField, passField };
	}

	/**
	 * Exchange code/state to tokens using multiple strategies (GET, POST JSON, POST FORM).
	 * Logs response body (clipped) on failure for easier debugging.
	 *
	 * @param {string} code
	 * @param {string} state
	 * @returns {Promise<any>}
	 */
	async _exchangeCodeForTokens(code, state) {
		const base = 'https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/token';

		const tryOne = async (label, fn) => {
			try {
				this._logDebug(`token exchange try=${label} ${safeHostPath(base)}`);
				const r = await fn();
				if (r?.status !== 200) {
					throw new Error(`status ${r?.status}`);
				}
				if (!r.data?.access_token || !r.data?.refresh_token) {
					throw new Error('missing access_token/refresh_token');
				}
				return r.data;
			} catch (e) {
				const status = e?.response?.status || e?.status;
				const data = e?.response?.data;
				this._logDebug(
					`token exchange failed try=${label} status=${status || 'n/a'} body=${clip(data || e.message)}`,
				);
				throw e;
			}
		};

		// A) GET with query
		try {
			const url = `${base}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
			return await tryOne('GET_query', () => this.client.get(url, { headers: { Accept: 'application/json' } }));
		} catch {
			// continue
		}

		// B) POST JSON
		try {
			return await tryOne('POST_json', () =>
				this.client.post(
					base,
					{ code, state },
					{ headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
				),
			);
		} catch {
			// continue
		}

		// C) POST x-www-form-urlencoded
		return await tryOne('POST_form', () =>
			this.client.post(base, new URLSearchParams({ code, state }).toString(), {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
			}),
		);
	}

	/**
	 * @param {string} email
	 * @param {string} password
	 */
	async login(email, password) {
		if (!email || !password) {
			throw new Error('E-Mail/Passwort fehlen');
		}

		for (let attempt = 1; attempt <= 3; attempt++) {
			this._logDebug(`=== login attempt ${attempt}/3 ===`);

			// fresh jar
			if (typeof this.jar.removeAllCookiesSync === 'function') {
				this.jar.removeAllCookiesSync();
			} else {
				this.jar = new CookieJar();
				this.client.defaults.jar = this.jar;
			}

			const { authUrl, authHtml } = await this._getAuthPage();
			const { actionUrl, fields, userField, passField } = this._parseLoginForm(authUrl, authHtml);

			fields[userField] = email;
			fields[passField] = password;

			const body = new URLSearchParams(fields).toString();
			this._logDebug(
				`POST authenticate ${safeHostPath(actionUrl)} (len=${body.length}) referer=${safeHostPath(authUrl)}`,
			);

			let resp = await this.client.post(actionUrl, body, {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Referer: authUrl,
					Accept: 'text/html,application/xhtml+xml',
				},
			});

			let safety = 0;
			while (safety++ < 20) {
				const loc = resp.headers.location;
				this._logDebug(
					`step status=${resp.status} hasLocation=${!!loc} next=${loc ? safeHostPath(loc) : '(none)'}`,
				);

				if (loc && loc.startsWith('ondus://')) {
					const { code, state } = parseOndusLocation(loc);
					if (!code || !state) {
						throw new Error('ondus Redirect ohne code/state erhalten');
					}

					this._logDebug(
						`GET token exchange ${safeHostPath('https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/token')} (query hidden)`,
					);

					const tokens = await this._exchangeCodeForTokens(code, state);
					this._logDebug(`token ok keys=${Object.keys(tokens).join(',')}`);
					return tokens;
				}

				if (loc && (resp.status === 302 || resp.status === 303)) {
					const nextUrl = toAbsUrl(actionUrl, loc);
					resp = await this.client.get(nextUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
					continue;
				}

				if (resp.status === 200 && typeof resp.data === 'string') {
					const known = this._detectKnownHtmlErrors(resp.data);
					if (known) {
						this._logDebug(`HTML error detected: ${known}`);
						if (known === 'RESTART_COOKIE_NOT_FOUND' && attempt < 3) {
							this._logDebug('Retrying due to restart cookie issue...');
							break;
						}
						if (known === 'MFA_REQUIRED') {
							throw new Error('MFA/2FA erforderlich – automatischer Login nicht möglich.');
						}
						if (known === 'INVALID_CREDENTIALS') {
							throw new Error('Ungültige Zugangsdaten (Keycloak).');
						}
						throw new Error(`Keycloak Fehlerseite: ${known}`);
					}
					throw new Error('Login fehlgeschlagen (Keycloak lieferte HTML statt Redirect).');
				}

				throw new Error(`Unerwarteter Login-Flow Zustand (${resp.status})`);
			}
		}

		throw new Error('Login fehlgeschlagen (nach 3 Versuchen).');
	}
}

module.exports = GroheLogin;
