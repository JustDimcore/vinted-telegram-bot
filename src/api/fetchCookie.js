import { executeWithDetailedHandling } from "../helpers/execute_helper.js";
import Logger from "../utils/logger.js";
import ConfigurationManager from "../utils/config_manager.js";
import RequestBuilder from "../utils/request_builder.js";

const settings = ConfigurationManager.getAlgorithmSetting;
const defaultExtension = settings.vinted_api_domain_extension;

/**
 * Fetches the session cookie of one Vinted marketplace.
 *
 * Each marketplace issues its own token, so the domain is a parameter: a cookie from
 * vinted.fr is rejected by the API of vinted.pl with 401 invalid_authentication_token.
 * @param {string} [domain] - Domain extension, for example "fr" or "co.uk".
 * @returns {Promise<{cookie: string}>}
 * @throws {DetailedExecutionResultError}
 */
export async function fetchCookie(domain = defaultExtension) {
    return await executeWithDetailedHandling(async () => {
        const url = `https://www.vinted.${domain}`;

        const response = await RequestBuilder.get(url).setNextProxy().send();

        if (response && response.headers['set-cookie']) {

            const cookies = response.headers['set-cookie'];
            // Vinted sends access_token_web twice: first an empty value (clearing the previous
            // session) and only then the valid JWT. A plain .find() returns the empty one,
            // so /api/v2/catalog/items answers 401 invalid_authentication_token.
            const prefix = 'access_token_web=';
            const vintedCookie = cookies
                .filter(cookie => cookie.startsWith(prefix) && cookie.split(';')[0].length > prefix.length)
                .pop();

            if (vintedCookie) {
                const cookie = vintedCookie.split(';')[0];
                Logger.debug(`Fetched cookie for vinted.${domain}`);

                return { cookie: cookie };
            }

            throw new Error("Session cookie not found in the headers.");
        }

        throw new Error("No cookies found in the headers.");
    });
}
