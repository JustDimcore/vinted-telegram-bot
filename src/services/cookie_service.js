import { fetchCookie } from '../api/fetchCookie.js';
import Logger from '../utils/logger.js';
import ConfigurationManager from '../utils/config_manager.js';

// A Vinted token stays valid for a while, but refreshing it once a minute is cheap and
// keeps a subscription from failing on an expired session.
const REFRESH_INTERVAL_MS = 60000;
const RETRY_DELAY_MS = 200;

const defaultDomain = ConfigurationManager.getAlgorithmSetting.vinted_api_domain_extension;

/**
 * Holds one session cookie per Vinted marketplace.
 *
 * The Discord original knew a single domain and kept one cookie in a variable. Users of the
 * Telegram bot bring URLs from different marketplaces, and a cookie of vinted.fr is rejected
 * by the API of vinted.pl, so the cookies are kept per domain.
 */
class CookieService {
    static cookies = new Map();
    static pending = new Map();
    static refreshTimer = null;

    /**
     * Fetches a cookie for a domain, retrying until one arrives.
     * @param {string} domain - Domain extension.
     * @param {number} [maxAttempts] - How often to retry before giving up.
     * @returns {Promise<string|null>} - The cookie, or null when it could not be fetched.
     */
    static async fetch(domain, maxAttempts = Infinity) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const fetched = await fetchCookie(domain);
                if (fetched.cookie) {
                    this.cookies.set(domain, fetched.cookie);
                    Logger.info(`Fetched cookie for vinted.${domain}`);
                    return fetched.cookie;
                }
            } catch (error) {
                Logger.debug(`Error fetching cookie for vinted.${domain}: ${error.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }

        return null;
    }

    /**
     * Returns the cookie of a domain, fetching it on first use.
     * Concurrent callers for the same domain share one request.
     * @param {string} [domain] - Domain extension.
     * @returns {Promise<string|null>} - The cookie.
     */
    static async get(domain = defaultDomain) {
        const known = this.cookies.get(domain);
        if (known) {
            return known;
        }

        if (this.pending.has(domain)) {
            return await this.pending.get(domain);
        }

        // A new marketplace must not block its subscription forever, so this attempt is bounded.
        const request = this.fetch(domain, 20).finally(() => this.pending.delete(domain));
        this.pending.set(domain, request);

        return await request;
    }

    /**
     * Starts refreshing every known cookie in the background.
     */
    static startAutoRefresh() {
        if (this.refreshTimer) {
            return;
        }

        this.refreshTimer = setInterval(async () => {
            for (const domain of this.cookies.keys()) {
                try {
                    await this.fetch(domain, 3);
                } catch (error) {
                    Logger.debug(`Error refreshing cookie for vinted.${domain}`);
                }
            }
        }, REFRESH_INTERVAL_MS);
    }

    static stopAutoRefresh() {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }
}

export default CookieService;
