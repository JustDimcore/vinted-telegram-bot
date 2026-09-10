import { randomUUID } from "crypto";
import { User, Subscription } from "./database.js";
import EventEmitter from "./utils/event_emitter.js";
import ConfigurationManager from "./utils/config_manager.js";

const userDefaultConfig = ConfigurationManager.getUserConfig;
const adminIds = ConfigurationManager.getTelegramConfig.admin_ids;

// The monitor service listens for 'updated' and re-reads the list of subscriptions.
// Only changes that affect what is monitored emit it - counters and timestamps do not,
// otherwise every delivered item would restart all timers.
const eventEmitter = new EventEmitter();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Creates a user.
 * @param {Object} userData - Data of the Telegram user.
 * @returns {Promise<Object>} - The created user.
 */
async function createUser({ telegramId, chatId, username = null, firstName = null, languageCode = 'en', preferences = {} }) {
    const user = new User({
        telegramId: String(telegramId),
        chatId: String(chatId ?? telegramId),
        username,
        firstName,
        languageCode,
        preferences,
        subscriptions: [],
        lastUpdated: new Date(),
        maxSubscriptions: userDefaultConfig.max_subscriptions_default,
    });

    const result = await user.save();
    eventEmitter.emit('updated');
    return result;
}

/**
 * Returns the user of a Telegram context, creating it on first contact.
 * @param {Object} from - Telegram "from" object.
 * @param {string|number} chatId - Chat the message came from.
 * @returns {Promise<Object>} - The user with populated subscriptions.
 */
async function getOrCreateUser(from, chatId) {
    const telegramId = String(from.id);
    let user = await User.findOne({ telegramId }).populate('subscriptions');

    if (!user) {
        await createUser({
            telegramId,
            chatId,
            username: from.username ?? null,
            firstName: from.first_name ?? null,
            languageCode: from.language_code ?? 'en',
        });
        return await User.findOne({ telegramId }).populate('subscriptions');
    }

    // The profile is refreshed silently, a renamed account should not need a re-registration.
    const changed = user.username !== (from.username ?? null)
        || user.firstName !== (from.first_name ?? null)
        || (from.language_code && user.languageCode !== from.language_code);

    if (changed) {
        user.username = from.username ?? null;
        user.firstName = from.first_name ?? null;
        if (from.language_code) {
            user.languageCode = from.language_code;
        }
        await user.save();
    }

    return user;
}

/**
 * Gets a user by their Telegram ID.
 * @param {string|number} telegramId - Telegram user id.
 * @returns {Promise<Object|null>} - The user.
 */
async function getUserByTelegramId(telegramId) {
    return await User.findOne({ telegramId: String(telegramId) }).populate('subscriptions');
}

/**
 * Gets a user by their database ID.
 * @param {string} id - Mongo ObjectId.
 * @returns {Promise<Object|null>} - The user.
 */
async function getUserById(id) {
    return await User.findById(id).populate('subscriptions');
}

/**
 * Checks whether a Telegram user is configured as an administrator.
 * @param {string|number} telegramId - Telegram user id.
 * @returns {boolean} - True for an administrator.
 */
function isUserAdmin(telegramId) {
    return adminIds.includes(String(telegramId));
}

/**
 * Sets how many subscriptions a user may run at once.
 * @param {string|number} telegramId - Telegram user id.
 * @param {number} maxSubscriptions - New limit.
 * @returns {Promise<Object|null>} - The updated user.
 */
async function setUserMaxSubscriptions(telegramId, maxSubscriptions) {
    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) {
        return null;
    }

    user.maxSubscriptions = maxSubscriptions;
    const result = await user.save();
    eventEmitter.emit('updated');
    return result;
}

async function getAllUsers() {
    return await User.find().populate('subscriptions');
}

async function deleteUser(id) {
    return await User.findByIdAndDelete(id);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function setPreferenceKey(model, idKey, idValue, key, value) {
    const entity = await model.findOne({ [idKey]: idValue });

    if (entity) {
        entity.preferences.set(key, value);
        entity.markModified('preferences');
        await entity.save();
    }

    eventEmitter.emit('updated');
    return entity;
}

async function setUserPreference(telegramId, key, value) {
    return await setPreferenceKey(User, 'telegramId', String(telegramId), key, value);
}

async function getUserPreference(telegramId, key) {
    const user = await User.findOne({ telegramId: String(telegramId) });
    return user ? user.preferences.get(key) : undefined;
}

async function setSubscriptionPreference(subscriptionId, key, value) {
    return await setPreferenceKey(Subscription, 'subscriptionId', subscriptionId, key, value);
}

async function getSubscriptionPreference(subscriptionId, key) {
    const subscription = await Subscription.findOne({ subscriptionId });
    return subscription ? subscription.preferences.get(key) : undefined;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Creates a subscription and links it to its owner.
 * @param {Object} data - Subscription data.
 * @returns {Promise<Object>} - The created subscription.
 */
async function createSubscription({ name, url, chatId, threadId = null, user, bannedKeywords = [], preferences = {} }) {
    const subscription = new Subscription({
        subscriptionId: randomUUID(),
        name,
        url,
        chatId: String(chatId),
        threadId,
        bannedKeywords,
        isMonitoring: true,
        user: user._id,
        preferences,
        lastUpdated: new Date(),
    });

    const result = await subscription.save();

    await User.findByIdAndUpdate(user._id, { $push: { subscriptions: result._id } });

    eventEmitter.emit('updated');
    return result;
}

async function getSubscriptionById(subscriptionId) {
    return await Subscription.findOne({ subscriptionId }).populate('user');
}

async function getSubscriptionsByTelegramId(telegramId) {
    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) {
        return [];
    }

    return await Subscription.find({ user: user._id }).populate('user').sort({ _id: 1 });
}

async function getAllSubscriptions() {
    return await Subscription.find().populate('user');
}

/**
 * All subscriptions the monitor should watch.
 * @returns {Promise<Array<Object>>} - Active subscriptions with their owner.
 */
async function getAllMonitoredSubscriptions() {
    return await Subscription.find({ isMonitoring: true }).populate('user');
}

async function updateSubscription(subscriptionId, update) {
    const result = await Subscription.findOneAndUpdate({ subscriptionId }, update, { new: true });
    eventEmitter.emit('updated');
    return result;
}

async function startSubscriptionMonitoring(subscriptionId) {
    return await updateSubscription(subscriptionId, { isMonitoring: true, lastUpdated: new Date() });
}

async function stopSubscriptionMonitoring(subscriptionId) {
    return await updateSubscription(subscriptionId, { isMonitoring: false, lastUpdated: new Date() });
}

async function setSubscriptionBannedKeywords(subscriptionId, bannedKeywords) {
    return await updateSubscription(subscriptionId, { bannedKeywords });
}

async function setSubscriptionUrl(subscriptionId, url) {
    // A different search invalidates the position in the result list.
    return await updateSubscription(subscriptionId, { url, lastSeenItemId: 0 });
}

async function setSubscriptionName(subscriptionId, name) {
    return await updateSubscription(subscriptionId, { name });
}

/**
 * Stores the newest reported item id. Deliberately without an "updated" event:
 * this runs after every check and must not restart the monitor timers.
 * @param {string} subscriptionId - Subscription identifier.
 * @param {number} lastSeenItemId - Highest reported item id.
 * @returns {Promise<void>}
 */
async function setSubscriptionLastSeenItemId(subscriptionId, lastSeenItemId) {
    await Subscription.updateOne({ subscriptionId }, { $set: { lastSeenItemId } });
}

async function incrementSubscriptionItemsFound(subscriptionId, count = 1) {
    await Subscription.updateOne(
        { subscriptionId },
        { $inc: { itemsFound: count }, $set: { lastUpdated: new Date(), keepMessageSent: false } }
    );
}

async function setSubscriptionKeepMessageSent(subscriptionId, keepMessageSent) {
    await Subscription.updateOne({ subscriptionId }, { $set: { keepMessageSent } });
}

async function setSubscriptionUpdatedAtNow(subscriptionId) {
    await Subscription.updateOne({ subscriptionId }, { $set: { lastUpdated: new Date() } });
}

/**
 * Deletes a subscription and unlinks it from its owner.
 * @param {string} subscriptionId - Subscription identifier.
 * @returns {Promise<Object|null>} - The deleted subscription.
 */
async function deleteSubscription(subscriptionId) {
    const subscription = await Subscription.findOne({ subscriptionId });
    if (!subscription) {
        return null;
    }

    if (subscription.user) {
        await User.findByIdAndUpdate(subscription.user, { $pull: { subscriptions: subscription._id } });
    }

    const result = await Subscription.findByIdAndDelete(subscription._id);
    eventEmitter.emit('updated');
    return result;
}

/**
 * Deletes every subscription of one user.
 * @param {string|number} telegramId - Telegram user id.
 * @returns {Promise<number>} - Number of deleted subscriptions.
 */
async function deleteAllSubscriptionsOfUser(telegramId) {
    const user = await User.findOne({ telegramId: String(telegramId) });
    if (!user) {
        return 0;
    }

    const result = await Subscription.deleteMany({ user: user._id });
    user.subscriptions = [];
    await user.save();

    eventEmitter.emit('updated');
    return result.deletedCount ?? 0;
}

/**
 * Stops every subscription that delivers into a chat, used when the bot was blocked there.
 * @param {string|number} chatId - Chat identifier.
 * @returns {Promise<number>} - Number of stopped subscriptions.
 */
async function stopSubscriptionsOfChat(chatId) {
    const result = await Subscription.updateMany(
        { chatId: String(chatId), isMonitoring: true },
        { $set: { isMonitoring: false } }
    );

    const stopped = result.modifiedCount ?? 0;
    if (stopped > 0) {
        eventEmitter.emit('updated');
    }

    return stopped;
}

async function countUsers() {
    return await User.countDocuments();
}

async function countSubscriptions(filter = {}) {
    return await Subscription.countDocuments(filter);
}

const crud = {
    // users
    createUser,
    getOrCreateUser,
    getUserByTelegramId,
    getUserById,
    getAllUsers,
    deleteUser,
    isUserAdmin,
    setUserMaxSubscriptions,
    // preferences
    setUserPreference,
    getUserPreference,
    setSubscriptionPreference,
    getSubscriptionPreference,
    // subscriptions
    createSubscription,
    getSubscriptionById,
    getSubscriptionsByTelegramId,
    getAllSubscriptions,
    getAllMonitoredSubscriptions,
    updateSubscription,
    startSubscriptionMonitoring,
    stopSubscriptionMonitoring,
    setSubscriptionBannedKeywords,
    setSubscriptionUrl,
    setSubscriptionName,
    setSubscriptionLastSeenItemId,
    incrementSubscriptionItemsFound,
    setSubscriptionKeepMessageSent,
    setSubscriptionUpdatedAtNow,
    deleteSubscription,
    deleteAllSubscriptionsOfUser,
    stopSubscriptionsOfChat,
    // stats
    countUsers,
    countSubscriptions,
    eventEmitter,
};

export default crud;
