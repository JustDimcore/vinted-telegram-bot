import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// Check if .env.local exists and load environment variables from it, overriding the default .env values
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
}

/**
 * Parses a comma separated list of ids into an array of trimmed strings.
 * @param {string|undefined} value - Raw environment value.
 * @returns {Array<string>} - Ids without empty entries.
 */
function parseIdList(value) {
    return (value || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0);
}

/**
 * Static class to manage application configurations.
 */
class ConfigurationManager {
    /**
     * Retrieves the Telegram configuration section from environment variables.
     * @returns {Object} Telegram configuration object.
     */
    static getTelegramConfig = {
        token: process.env.TELEGRAM_BOT_TOKEN,
        admin_ids: parseIdList(process.env.TELEGRAM_ADMIN_IDS),
        allowed_user_ids: parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS),
        // Telegram allows at most 10 media in one album, and a caption of 1024 characters.
        item_photos: Math.min(Math.max(Number(process.env.ITEM_PHOTOS) || 1, 1), 10),
        subscription_inactivity_enabled: process.env.ENABLE_SUBSCRIPTION_INACTIVITY == 1,
        subscription_inactivity_hours: Number(process.env.SUBSCRIPTION_INACTIVITY_HOURS) || 72,
        subscription_inactivity_delete_hours: Number(process.env.SUBSCRIPTION_INACTIVITY_DELETE_HOURS) || 24,
    }

    /**
     * Retrieves the MongoDB configuration section from environment variables.
     * @returns {Object} MongoDB configuration object.
     */
    static getMongoDBConfig = {
        uri: process.env.MONGODB_URI
    }

    /**
     * Retrieves the user configuration from environment variables.
     * @returns {Object} User configuration object.
     */
    static getUserConfig = {
        max_subscriptions_default: Number(process.env.USER_MAX_SUBSCRIPTIONS_DEFAULT) || 5,
    }

    static getPermissionConfig = {
        allow_user_to_create_subscriptions: process.env.ALLOW_USER_TO_CREATE_SUBSCRIPTIONS == 1,
    }

    /**
     * Retrieves the algorithm settings from environment variables.
     * @returns {Object} Algorithm settings object.
     */
    static getAlgorithmSetting = {
        vinted_api_domain_extension: process.env.VINTED_API_DOMAIN_EXTENSION || 'fr',
        filter_zero_stars_profiles: process.env.ALGORITHM_FILTER_ZERO_STARS_PROFILES == 1,
        concurrent_requests: Number(process.env.ALGORITHM_CONCURRENT_REQUESTS) || 15,
        // How often a single subscription is checked. The default minute is a compromise between
        // notification speed and the load the bot puts on Vinted and on the network.
        monitor_interval_seconds: Number(process.env.MONITOR_INTERVAL_SECONDS) || 60,
        blacklisted_countries_codes: parseIdList(process.env.BLACKLISTED_COUNTRIES_CODES),
    }

    /**
     * Retrieves the rotating proxy configuration from environment variables.
     * @returns {Object} Proxy configuration.
     */
    static getProxiesConfig = {
        use_webshare: process.env.USE_WEBSHARE == 1,
        webshare_api_key: process.env.WEBSHARE_API_KEY,
    }

    static getDevMode = process.env.DEV_MODE == 1;
    static getDumpLogs = process.env.DUMP_LOGS == 1;
}

export default ConfigurationManager;
