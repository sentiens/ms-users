const { HttpStatusError } = require('common-errors');
const uuid = require('uuid/v4');
const redisKey = require('./key');
const handlePipeline = require('../utils/pipelineError.js');

/**
 * Verify ip limits
 * @param  {redisCluster} redis
 * @param  {Object} registrationLimits
 * @param  {String} ipaddress
 * @return {Function}
 */
module.exports = async function checkLimits(redis, registrationLimits, ipaddress) {
  const { ip: { time, times } } = registrationLimits;
  const ipaddressLimitKey = redisKey('reg-limit', ipaddress);
  const now = Date.now();
  const old = now - time;

  const props = await redis
    .pipeline()
    .zadd(ipaddressLimitKey, now, uuid())
    .pexpire(ipaddressLimitKey, time)
    .zremrangebyscore(ipaddressLimitKey, '-inf', old)
    .zcard(ipaddressLimitKey)
    .exec()
    .then(handlePipeline);

  const cardinality = props[3];
  if (cardinality > times) {
    const msg = 'You can\'t register more users from your ipaddress now';
    throw new HttpStatusError(429, msg);
  }

  return props;
};
