const Promise = require('bluebird');
const passThrough = require('lodash/identity');
const { ActionTransport } = require('@microfleet/core');
const { getInternalData } = require('../utils/userData');
const getMetadata = require('../utils/getMetadata');
const isActive = require('../utils/isActive');
const challenge = require('../utils/challenges/challenge');
const {
  USERS_ACTION_ACTIVATE,
  USER_ALREADY_ACTIVE,
  USERS_USERNAME_FIELD,
} = require('../constants');

/**
 * Predicate for inactive status
 */
const inactiveStatus = { statusCode: 412 };

/**
 * Assigns data to passed context
 */
function assignInternalData(data) {
  this.internalData = data;
}

/**
 * fetches internal data
 */
function fetchInternalData() {
  return getInternalData
    .call(this.service, this[USERS_USERNAME_FIELD])
    .bind(this)
    .tap(assignInternalData);
}

/**
 * Returns username from internal data
 */
function fetchMetadata() {
  // remap to the actual username
  const username = this[USERS_USERNAME_FIELD] = this.internalData[USERS_USERNAME_FIELD];

  // fetch all the required metadata
  return getMetadata
    .call(this.service, username, this.defaultAudience)
    .get(this.defaultAudience);
}

/**
 * Creates actual challenge
 */
function createChallenge(metadata) {
  return challenge.call(
    this.service,
    this.type,
    {
      id: this[USERS_USERNAME_FIELD],
      action: USERS_ACTION_ACTIVATE,
      ttl: this.ttl,
      throttle: this.throttle,
    },
    metadata
  );
}

/**
 * @api {amqp} <prefix>.challenge Creates user challenges
 * @apiVersion 1.0.0
 * @apiName ChallengeUser
 * @apiGroup Users
 *
 * @apiDescription Must be used internally to create user challenges. Currently only email challenge is supported. Contains
 * password reset challenge & account activation challenge. The latter is called from the `registration` action automatically,
 * when the account must complete the challenge
 *
 * @apiParam (Payload) {String="email"} type - type of challenge, only "email" is supported now
 * @apiParam (Payload) {String} username - user's username
 * @apiParam (Payload) {String} [remoteip] - used for security log
 * @apiParam (Payload) {String} [metadata] - not used, but in the future this would be associated with user when challenge is required
 *
 */
module.exports = function sendChallenge({ params }) {
  // TODO: record all attempts
  // TODO: add metadata processing on successful email challenge

  const service = this;
  const { config } = service;
  const { defaultAudience } = config.jwt;
  const { throttle, ttl } = config.token[params.type];

  const ctx = {
    service,
    throttle,
    ttl,
    defaultAudience,
    type: params.type,
    [USERS_USERNAME_FIELD]: params.username,
  };

  return Promise
    .bind(ctx)
    .then(fetchInternalData)
    .tap(isActive)
    .throw(USER_ALREADY_ACTIVE)
    .catch(inactiveStatus, passThrough)
    .then(fetchMetadata)
    .then(createChallenge);
};

module.exports.transports = [ActionTransport.amqp];
