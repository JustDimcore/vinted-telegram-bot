import { fetchCookie } from '../api/fetchCookie.js';
import Logger from '../utils/logger.js';
import ConfigurationManager from '../utils/config_manager.js';

// A working cookie is refreshed once a minute, which keeps a subscription from running into
// an expired session.
const REFRESH_INTERVAL_MS = 60 * 1000;
// After a failed attempt the wait doubles, starting at the refresh interval, up to this
// ceiling. A marketplace that refuses is neither asked every minute nor in a burst of retries.
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

const defaultDomain = ConfigurationManager.getAlgorithmSetting.vinted_api_domain_extension;

/**
 * Holds one session cookie per Vinted marketplace.
 *
 * Users bring URLs from different marketplaces, and a cookie of one marketplace is not
 * accepted by another, so the cookies are kept per domain.
 */
class CookieService {
    static cookies = new Map();
    // domain -> { delayMs, retryAt } after a failed attempt
    static failures = new Map();
    static pending = new Map();
    static refreshTimer = null;
    // A property rather than a direct call, so tests can replace the network request.
    static fetchCookie = fetchCookie;

    /**
     * Makes exactly one attempt to fetch the cookie of a domain.
     * @param {string} domain - Domain extension.
     * @returns {Promise<string|null>} - The cookie, or null when the attempt failed.
     */
    static async fetch(domain) {
        let result;
        try {
            result = await this.fetchCookie(domain);
        } catch (error) {
            result = { success: false, error: error.message };
        }

        if (result?.cookie) {
            const firstTime = !this.cookies.has(domain);
            const recovered = this.failures.has(domain);

            this.cookies.set(domain, result.cookie);
            this.failures.delete(domain);

            // The routine refresh once a minute would drown the log, only the news is logged.
            if (firstTime || recovered) {
                Logger.info(`Fetched cookie for vinted.${domain}`);
            } else {
                Logger.debug(`Refreshed cookie for vinted.${domain}`);
            }
            return result.cookie;
        }

        const previous = this.failures.get(domain);
        const delayMs = previous
            ? Math.min(previous.delayMs * 2, MAX_RETRY_DELAY_MS)
            : REFRESH_INTERVAL_MS;
        this.failures.set(domain, { delayMs, retryAt: Date.now() + delayMs });

        Logger.warn(`Could not fetch cookie for vinted.${domain} (next attempt in ${Math.round(delayMs / 1000)}s): ${result?.error ?? 'no cookie in the response'}`);
        return null;
    }

    /**
     * Whether a domain is waiting out its delay after a failed attempt.
     * @param {string} domain - Domain extension.
     * @returns {boolean} - True while no new attempt should be made.
     */
    static isWaiting(domain) {
        const failure = this.failures.get(domain);
        return Boolean(failure) && Date.now() < failure.retryAt;
    }

    /**
     * Runs one attempt for a domain, sharing it with anyone who asks meanwhile.
     * @param {string} domain - Domain extension.
     * @returns {Promise<string|null>} - The cookie, or null.
     */
    static request(domain) {
        if (!this.pending.has(domain)) {
            const attempt = this.fetch(domain).finally(() => this.pending.delete(domain));
            this.pending.set(domain, attempt);
        }
        return this.pending.get(domain);
    }

    /**
     * Returns the cookie of a domain, fetching it on first use.
     * @param {string} [domain] - Domain extension.
     * @returns {Promise<string|null>} - The cookie; null while the marketplace refuses to hand one out.
     */
    static async get(domain = defaultDomain) {
        const known = this.cookies.get(domain);
        if (known) {
            return known;
        }

        // While the marketplace refuses, callers go on without a cookie instead of each one
        // triggering another request.
        if (this.isWaiting(domain)) {
            return null;
        }

        return await this.request(domain);
    }

    /**
     * Starts refreshing every known domain in the background.
     */
    static startAutoRefresh() {
        if (this.refreshTimer) {
            return;
        }

        this.refreshTimer = setInterval(async () => {
            const domains = new Set([...this.cookies.keys(), ...this.failures.keys()]);
            for (const domain of domains) {
                if (this.isWaiting(domain)) {
                    continue;
                }
                await this.request(domain);
            }
        }, REFRESH_INTERVAL_MS);
    }

    static stopAutoRefresh() {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }
}

export default CookieService;
