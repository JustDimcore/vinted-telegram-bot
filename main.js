import ProxyManager from "./src/utils/proxy_manager.js";
import ConfigurationManager from "./src/utils/config_manager.js";
import Logger from "./src/utils/logger.js";
import LanguageService from "./src/utils/language.js";
import crud from "./src/crud.js";
import { Preference } from "./src/database.js";
import { bot, setupBot } from "./src/bot/client.js";
import CookieService from "./src/services/cookie_service.js";
import TelegramService from "./src/services/telegram_service.js";
import SubscriptionMonitorService from "./src/services/subscription_monitor_service.js";
import { checkSubscriptionInactivity } from "./src/services/inactivity_service.js";
import { getDomainFromUrl } from "./src/services/url_service.js";
import {
    buildItemCaption,
    buildItemKeyboard,
    buildItemMediaGroup,
} from "./src/bot/components/item_message.js";

const INACTIVITY_CHECK_INTERVAL_MS = 1000 * 60 * 30;

const algorithmSettings = ConfigurationManager.getAlgorithmSetting;
const telegramConfig = ConfigurationManager.getTelegramConfig;

try {
    await ProxyManager.init();
} catch (error) {
    Logger.error(`Failed to initialize proxies: ${error.message}`);
    Logger.info('Continuing without proxies...');
}

/**
 * Language a subscription should be written in.
 * @param {Object} subscription - The subscription with its populated owner.
 * @returns {string} - Language code.
 */
function languageOf(subscription) {
    const user = subscription.user;
    const preferred = user?.preferences?.get?.(Preference.Language);
    return LanguageService.resolve(preferred || user?.languageCode);
}

/**
 * Sends one found item into the chat of its subscription.
 * @param {Object} item - The item.
 * @param {Object} subscription - The subscription that found it.
 * @returns {Promise<void>}
 */
const sendItem = async (item, subscription) => {
    // The domain of the subscription URL decides which marketplace the links point to.
    const domain = getDomainFromUrl(subscription.url);
    const lang = languageOf(subscription);
    const silent = Boolean(subscription.user?.preferences?.get?.(Preference.Silent));

    const options = {
        disable_notification: silent,
        ...(subscription.threadId ? { message_thread_id: subscription.threadId } : {}),
    };

    const photos = item.getPhotoUrls(telegramConfig.item_photos);

    try {
        if (photos.length > 1) {
            // Telegram allows no buttons below an album, so the links go into the caption.
            const caption = buildItemCaption({
                item,
                domain,
                lang,
                subscriptionName: subscription.name,
                withLinks: true,
            });

            await TelegramService.sendMediaGroup(
                subscription.chatId,
                buildItemMediaGroup(item, caption, telegramConfig.item_photos),
                options
            );
            return;
        }

        const caption = buildItemCaption({
            item,
            domain,
            lang,
            subscriptionName: subscription.name,
            withLinks: photos.length === 0,
        });

        if (photos.length === 1) {
            await TelegramService.sendPhoto(subscription.chatId, photos[0], caption, {
                ...options,
                reply_markup: buildItemKeyboard(item, domain, lang),
            });
            return;
        }

        // An item without a usable photo still deserves a notification.
        await TelegramService.sendText(subscription.chatId, caption, {
            ...options,
            reply_markup: buildItemKeyboard(item, domain, lang),
        });
    } catch (error) {
        // Telegram downloads the photo itself and sometimes refuses it (too large, wrong
        // type, host unreachable). The item is then sent as plain text rather than dropped.
        Logger.debug(`Sending item ${item.id} with photo failed: ${error.message}`);

        try {
            const caption = buildItemCaption({
                item,
                domain,
                lang,
                subscriptionName: subscription.name,
                withLinks: true,
            });

            await TelegramService.sendText(subscription.chatId, caption, options);
        } catch (fallbackError) {
            Logger.error(`Could not notify chat ${subscription.chatId} about item ${item.id}: ${fallbackError.message}`);
        }
    }
};

Logger.info('Starting Vinted Telegram Bot');
Logger.info('Fetching cookie from Vinted');

// The cookie of the configured default marketplace is fetched up front, so a
// misconfigured domain or a blocked proxy shows up before the bot answers anyone.
await CookieService.get(algorithmSettings.vinted_api_domain_extension);
CookieService.startAutoRefresh();

TelegramService.init(bot);
await setupBot();

// bot.start() resolves only when the bot stops, so it is deliberately not awaited.
bot.start({
    drop_pending_updates: true,
    onStart: info => Logger.info(`Logged in as @${info.username}`),
}).catch(error => Logger.error(`Bot stopped: ${error.message}`));

Logger.info('Starting subscription monitoring');

await SubscriptionMonitorService.start({
    getSubscriptions: () => crud.getAllMonitoredSubscriptions(),
    getCookie: domain => CookieService.get(domain),
    intervalMinMs: algorithmSettings.monitor_interval_seconds * 1000,
    intervalMaxMs: algorithmSettings.monitor_interval_max_seconds * 1000,
    onItem: sendItem,
});

crud.eventEmitter.on('updated', async () => {
    await SubscriptionMonitorService.refresh();
    Logger.debug('Refreshed monitored subscriptions');
});

if (telegramConfig.subscription_inactivity_enabled) {
    setInterval(checkSubscriptionInactivity, INACTIVITY_CHECK_INTERVAL_MS);
}

/**
 * Stops the timers and the long polling instead of dropping the connection.
 * @param {string} signal - Signal that triggered the shutdown.
 */
const shutdown = async signal => {
    Logger.info(`Received ${signal}, shutting down`);
    SubscriptionMonitorService.stop();
    CookieService.stopAutoRefresh();

    try {
        await bot.stop();
    } catch (error) {
        Logger.debug(`Error stopping the bot: ${error.message}`);
    }

    process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
