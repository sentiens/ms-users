const URLSafeBase64 = require('urlsafe-base64');
const Promise = require('bluebird');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const MockServer = require('ioredis/test/helpers/mock_server.js');
const Errors = require('common-errors');

// make sure we have stack
chai.config.includeStack = true;

const config = {
  amqp: {
    connection: {
      host: process.env.RABBITMQ_PORT_5672_TCP_ADDR || '127.0.0.1',
      port: +process.env.RABBITMQ_PORT_5672_TCP_PORT || 5672,
    },
  },
  redis: {
    hosts: [
      {
        host: process.env.REDIS_1_PORT_6379_TCP_ADDR || '127.0.0.1',
        port: +process.env.REDIS_1_PORT_6379_TCP_PORT || 30001,
      },
      {
        host: process.env.REDIS_2_PORT_6379_TCP_ADDR || '127.0.0.1',
        port: +process.env.REDIS_2_PORT_6379_TCP_PORT || 30002,
      },
      {
        host: process.env.REDIS_3_PORT_6379_TCP_ADDR || '127.0.0.1',
        port: +process.env.REDIS_3_PORT_6379_TCP_PORT || 30003,
      },
    ],
  },
};

describe('Users suite', function UserClassSuite() {
  const Users = require('../src');

  // inits redis mock cluster
  function redisMock() {
    const slotTable = [
      [0, 5460, ['127.0.0.1', 30001]],
      [5461, 10922, ['127.0.0.1', 30002]],
      [10923, 16383, ['127.0.0.1', 30003]],
    ];

    function argvHandler(argv) {
      if (argv[0] === 'cluster' && argv[1] === 'slots') {
        return slotTable;
      }
    }

    this.server_1 = new MockServer(30001, argvHandler);
    this.server_2 = new MockServer(30002, argvHandler);
    this.server_3 = new MockServer(30003, argvHandler);
  }

  // teardown cluster
  function tearDownRedisMock() {
    this.server_1.disconnect();
    this.server_2.disconnect();
    this.server_3.disconnect();
  }

  describe('configuration suite', function ConfigurationSuite() {
    beforeEach(redisMock);

    it('must throw on invalid configuration', function test() {
      expect(function throwOnInvalidConfiguration() {
        return new Users();
      }).to.throw(Errors.ValidationError);
    });

    it('must be able to connect to and disconnect from amqp', function test() {
      const users = new Users(config);
      return users._connectAMQP().tap(() => {
        return users._closeAMQP();
      });
    });

    it('must be able to connect to and disconnect from redis', function test() {
      const users = new Users(config);
      return users._connectRedis().tap(() => {
        return users._closeRedis();
      });
    });

    it('must be able to initialize and close service', function test() {
      const users = new Users(config);
      return users.connect().tap(() => {
        return users.close();
      });
    });

    afterEach(tearDownRedisMock);
  });

  describe('unit tests', function UnitSuite() {
    beforeEach(redisMock);

    beforeEach(function startService() {
      function emptyStub() {}

      this.users = new Users(config);
      this.users._mailer = {
        send: emptyStub,
      };
      this.users._redis = {};
      [ 'hexists', 'hsetnx', 'pipeline', 'expire', 'zadd', 'hgetallBuffer', 'get', 'set', 'hget', 'del' ].forEach(prop => {
        this.users._redis[prop] = emptyStub;
      });
    });

    describe('encrypt/decrypt suite', function cryptoSuite() {
      const emailValidation = require('../src/utils/send-email.js');

      it('must be able to encode and then decode token', function test() {
        const { algorithm, secret } = this.users._config.validation;
        const obj = { email: 'v@example.com', secret: 'super-secret' };
        const message = new Buffer(JSON.stringify(obj));
        const token = emailValidation.encrypt(algorithm, secret, message);
        expect(token).to.not.be.equal(JSON.stringify(obj));
        const decrypted = emailValidation.decrypt(algorithm, secret, token);
        expect(decrypted.toString()).to.be.eq(JSON.stringify(obj));
        expect(JSON.parse(decrypted)).to.be.deep.eq(obj);
      });
    });

    describe('#register', function registerSuite() {
      const headers = { routingKey: 'register' };

      it('must reject invalid registration params and return detailed error', function test() {
        return this.users.router({}, headers)
          .reflect()
          .then((registered) => {
            expect(registered.isRejected()).to.be.eq(true);
            expect(registered.reason().name).to.be.eq('ValidationError');
            expect(registered.reason().errors).to.have.length.of(3);
          });
      });

      it('must be able to create user without validations and return user object and jwt token', function test() {
        const opts = {
          username: 'v@makeomatic.ru',
          password: 'mynicepassword',
          audience: 'matic.ninja',
        };

        const pipeline = { hsetnx: sinon.stub(), exec: sinon.stub() };
        pipeline.exec.returns(Promise.resolve([
          [ null, 1 ],
          [ null, 1 ],
        ]));

        sinon.stub(this.users._redis, 'hexists').returns(Promise.resolve(false));
        sinon.stub(this.users._redis, 'pipeline').returns(pipeline);
        sinon.stub(this.users._redis, 'zadd').returns(1);
        sinon.stub(this.users._redis, 'hgetallBuffer')
          .onFirstCall().returns({})
          .onSecondCall().returns({});

        return this.users.router(opts, headers)
          .reflect()
          .then((registered) => {
            expect(registered.isFulfilled()).to.be.eq(true);
            expect(registered.value()).to.have.ownProperty('jwt');
            expect(registered.value()).to.have.ownProperty('user');
            expect(registered.value().user.username).to.be.eq(opts.username);
            expect(registered.value().user).to.have.ownProperty('metadata');
            expect(registered.value().user.metadata).to.have.ownProperty('matic.ninja');
            expect(registered.value().user.metadata).to.have.ownProperty('*.localhost');
            expect(registered.value().user).to.not.have.ownProperty('password');
            expect(registered.value().user).to.not.have.ownProperty('audience');
          });
      });

      it('must be able to create user with validation and return success', function test() {
        const opts = {
          username: 'v@makeomatic.ru',
          password: 'mynicepassword',
          audience: 'matic.ninja',
          activate: false,
        };

        const pipeline = { hsetnx: sinon.stub(), exec: sinon.stub() };
        pipeline.exec.returns(Promise.resolve([
          [ null, 1 ],
          [ null, 1 ],
        ]));

        const stub = sinon.stub().returns(Promise.resolve());
        this.users._mailer.send = stub;

        sinon.stub(this.users._redis, 'hexists').returns(Promise.resolve(false));
        sinon.stub(this.users._redis, 'pipeline').returns(pipeline);
        sinon.stub(this.users._redis, 'get')
          .onFirstCall().returns(Promise.resolve());
        sinon.stub(this.users._redis, 'set')
          .onFirstCall().returns(Promise.resolve(1));

        return this.users.router(opts, headers)
          .delay(50)
          .reflect()
          .then((registered) => {
            expect(registered.isFulfilled()).to.be.eq(true);
            expect(registered.value()).to.be.deep.eq({
              requiresActivation: true,
            });
            expect(stub.calledOnce).to.be.eq(true);
          });
      });

      it('must reject registration for an already existing user', function test() {
        const opts = {
          username: 'v@makeomatic.ru',
          password: 'mynicepassword',
          audience: 'matic.ninja',
          activate: false,
        };

        sinon.stub(this.users._redis, 'hexists').returns(Promise.resolve(true));

        return this.users.router(opts, headers)
          .delay(50)
          .reflect()
          .then((registered) => {
            expect(registered.isRejected()).to.be.eq(true);
            expect(registered.reason().name).to.be.eq('HttpStatusError');
            expect(registered.reason().statusCode).to.be.eq(403);
            expect(registered.reason().message).to.match(/"v@makeomatic\.ru" already exists/);
          });
      });

      it('must reject more than 3 registration a day per ipaddress if it is specified');
      it('must reject registration for disposable email addresses');
      it('must reject registration for a domain name, which lacks MX record');
      it('must reject registration when captcha is specified and its invalid');
      it('must register user when captcha is specified and its valid');
    });

    describe('#challenge', function challengeSuite() {
      const headers = { routingKey: 'challenge' };

      it('must fail to send a challenge for a non-existing user', function test() {
        sinon.stub(this.users._redis, 'hget').returns(Promise.resolve(null));

        return this.users.router({ username: 'oops@gmail.com', type: 'email' }, headers)
          .reflect()
          .then((validation) => {
            expect(validation.isRejected()).to.be.eq(true);
            expect(validation.reason().name).to.be.eq('HttpStatusError');
            expect(validation.reason().statusCode).to.be.eq(404);
          });
      });

      it('must fail to send a challenge for an already active user', function test() {
        sinon.stub(this.users._redis, 'hget').returns(Promise.resolve('true'));

        return this.users.router({ username: 'oops@gmail.com', type: 'email' }, headers)
          .reflect()
          .then((validation) => {
            expect(validation.isRejected()).to.be.eq(true);
            expect(validation.reason().name).to.be.eq('HttpStatusError');
            expect(validation.reason().statusCode).to.be.eq(412);
          });
      });

      it('must be able to send challenge email', function test() {
        sinon.stub(this.users._redis, 'hget').returns(Promise.resolve('false'));
        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(null));
        sinon.stub(this.users._redis, 'set').returns(Promise.resolve(1));
        sinon.stub(this.users._mailer, 'send').returns(Promise.resolve());

        return this.users.router({ username: 'oops@gmail.com', type: 'email' }, headers)
          .delay(50)
          .reflect()
          .then((validation) => {
            expect(validation.isFulfilled()).to.be.eq(true);
            expect(validation.value()).to.be.deep.eq({ queued: true });
            expect(this.users._mailer.send.calledOnce).to.be.eq(true);
          });
      });

      it('must fail to send challenge email more than once in an hour per user', function test() {
        sinon.stub(this.users._redis, 'hget').returns(Promise.resolve('false'));
        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(true));

        return this.users.router({ username: 'oops@gmail.com', type: 'email' }, headers)
          .reflect()
          .then((validation) => {
            expect(validation.isRejected()).to.be.eq(true);
            expect(validation.reason().name).to.be.eq('HttpStatusError');
            expect(validation.reason().statusCode).to.be.eq(429);
          });
      });

      it('must fail to send challeng email during race condition', function test() {
        sinon.stub(this.users._redis, 'hget').returns(Promise.resolve('false'));
        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(null));
        sinon.stub(this.users._redis, 'set').returns(Promise.resolve(0));

        return this.users.router({ username: 'oops@gmail.com', type: 'email' }, headers)
          .reflect()
          .then((validation) => {
            expect(validation.isRejected()).to.be.eq(true);
            expect(validation.reason().name).to.be.eq('HttpStatusError');
            expect(validation.reason().statusCode).to.be.eq(429);
          });
      });

      it('must validate MX record for a domain before sending an email');
    });

    describe('#activate', function activateSuite() {
      const headers = { routingKey: 'activate' };
      const emailValidation = require('../src/utils/send-email.js');
      const email = 'v@example.com';

      beforeEach(function genToken() {
        const { algorithm, secret } = this.users._config.validation;
        const token = 'incredible-secret';
        this.token = URLSafeBase64.encode(emailValidation.encrypt(algorithm, secret, new Buffer(JSON.stringify({ email, token }))));
      });

      it('must reject activation when challenge token is invalid', function test() {
        return this.users.router({ token: 'useless-token', namespace: 'activate' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isRejected()).to.be.eq(true);
            expect(activation.reason().name).to.be.eq('HttpStatusError');
            expect(activation.reason().statusCode).to.be.eq(403);
            expect(activation.reason().message).to.match(/could not decode token/);
          });
      });

      it('must reject activation when challenge token is expired or not found', function test() {
        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(null));

        return this.users.router({ token: this.token, namespace: 'activate' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isRejected()).to.be.eq(true);
            expect(activation.reason().name).to.be.eq('HttpStatusError');
            expect(activation.reason().statusCode).to.be.eq(404);
          });
      });

      it('must reject activation when associated email and the token doesn\'t match', function test() {
        sinon.stub(this.users._redis, 'get').returns(Promise.resolve('v@example.ru'));

        return this.users.router({ token: this.token, namespace: 'activate' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isRejected()).to.be.eq(true);
            expect(activation.reason().name).to.be.eq('HttpStatusError');
            expect(activation.reason().statusCode).to.be.eq(412);
            expect(activation.reason().message).to.match(/associated email doesn\'t match token/);
          });
      });

      it('must reject activation when account is already activated', function test() {
        // mock pipeline response
        const pipeline = {
          exec: sinon.stub().returns(Promise.resolve([
            [ null, 'true' ],
          ])),
        };
        pipeline.hget = sinon.stub().returns(pipeline);
        pipeline.hset = sinon.stub().returns(pipeline);
        pipeline.persist = sinon.stub().returns(pipeline);
        sinon.stub(this.users._redis, 'pipeline').returns(pipeline);

        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(email));
        sinon.stub(this.users._redis, 'del').returns(Promise.resolve());

        return this.users.router({ token: this.token, namespace: 'activate' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isRejected()).to.be.eq(true);
            expect(activation.reason().name).to.be.eq('HttpStatusError');
            expect(activation.reason().statusCode).to.be.eq(413);
            expect(activation.reason().message).to.match(/Account v@example\.com was already activated/);
          });
      });

      it('must activate account when challenge token is correct and not expired', function test() {
        // mock pipeline response
        const jwt = require('../src/utils/jwt.js');
        const pipeline = {
          exec: sinon.stub().returns(Promise.resolve([
            [ null, 'false' ],
          ])),
        };
        pipeline.hget = sinon.stub().returns(pipeline);
        pipeline.hset = sinon.stub().returns(pipeline);
        pipeline.persist = sinon.stub().returns(pipeline);
        sinon.stub(this.users._redis, 'pipeline').returns(pipeline);

        sinon.stub(this.users._redis, 'get').returns(Promise.resolve(email));
        sinon.stub(this.users._redis, 'del').returns(Promise.resolve());

        const stub = sinon.stub(jwt, 'login').returns(Promise.resolve());

        return this.users.router({ token: this.token, namespace: 'activate' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isFulfilled()).to.be.eq(true);
            expect(stub.calledOnce);
            stub.restore();
          });
      });

      it('must activate account when only username is specified as a service action', function test() {
        const jwt = require('../src/utils/jwt.js');
        const stub = sinon.stub(jwt, 'login').returns(Promise.resolve());

        sinon.stub(this.users._redis, 'hexists').returns(Promise.resolve(true));

        const pipeline = {
          exec: sinon.stub().returns(Promise.resolve([
            [ null, 'false' ],
          ])),
        };
        pipeline.hget = sinon.stub().returns(pipeline);
        pipeline.hset = sinon.stub().returns(pipeline);
        pipeline.persist = sinon.stub().returns(pipeline);
        sinon.stub(this.users._redis, 'pipeline').returns(pipeline);

        return this.users.router({ username: 'v@makeomatic.ru' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isFulfilled()).to.be.eq(true);
            expect(stub.calledOnce);
            stub.restore();
          });
      });

      it('must fail to activate account when only username is specified as a service action and the user does not exist', function test() {
        sinon.stub(this.users._redis, 'hexists').returns(Promise.resolve(false));

        return this.users.router({ username: 'v@makeomatic.ru' }, headers)
          .reflect()
          .then((activation) => {
            expect(activation.isRejected()).to.be.eq(true);
            expect(activation.reason().name).to.be.eq('HttpStatusError');
            expect(activation.reason().statusCode).to.be.eq(404);
            expect(activation.reason().message).to.be.eq('user does not exist');
          });
      });
    });

    describe('#login', function loginSuite() {
      it('must reject login on a non-existing username');
      it('must reject login on an invalid password');
      it('must reject login on an inactive account');
      it('must reject login on a banned account');
      it('must login on a valid account with correct credentials');
      it('must return User object and JWT token on login similar to #register+activate');
      it('must reject lock account for authentication after 3 invalid login attemps');
      it('must reset authentication attemps after resetting password');
    });

    describe('#logout', function logoutSuite() {
      it('must reject logout on an invalid JWT token');
      it('must delete JWT token from pool of valid tokens');
    });

    describe('#verify', function verifySuite() {
      it('must reject on an invalid JWT token');
      it('must reject on an expired JWT token');
      it('must return user object on a valid JWT token');
      it('must return user object and associated metadata on a valid JWT token with default audience');
      it('must return user object and associated metadata on a valid JWT token with provided audiences');
    });

    describe('#getMetadata', function getMetadataSuite() {
      it('must reject to return metadata on a non-existing username');
      it('must return metadata for a default audience of an existing user');
      it('must return metadata for default and passed audiences of an existing user');
    });

    describe('#updateMetadata', function getMetadataSuite() {
      it('must reject updating metadata on a non-existing user');
      it('must be able to add metadata for a single audience of an existing user');
      it('must be able to remove metadata for a single audience of an existing user');
      it('must be able to perform batch add/remove operations for a single audience of an existing user');
    });

    describe('#requestPassword', function requestPasswordSuite() {
      it('must reject for a non-existing user');
      it('must send challenge email for an existing user');
      it('must reject sending reset password emails for an existing user more than once in 3 hours');
    });

    describe('#updatePassword', function updatePasswordSuite() {
      it('must reject updating password for a non-existing user');
      it('must reject updating password for an invalid challenge token');
      it('must update password passed with a valid challenge token');
      it('must fail to update password with a valid challenge token, when it doesn\'t conform to password requirements');
      it('must reset login attemts for a user after resetting password');
    });

    describe('#ban', function banSuite() {
      it('must reject banning a non-existing user');
      it('must reject (un)banning a user without action being implicitly set');
      it('must ban an existing user');
      it('must unban an existing user');
      it('must fail to unban not banned user');
      it('must fail to ban already banned user');
    });

    afterEach(tearDownRedisMock);
  });

  describe('integration tests', function integrationSuite() {
    describe('#register', function registerSuite() {
      it('must reject invalid registration params and return detailed error');
      it('must be able to create user without validations and return user object and jwt token');
      it('must be able to create user with validation and return success');
      it('must reject more than 3 registration a day per ipaddress if it is specified');
      it('must reject registration for an already existing user');
      it('must reject registration for disposable email addresses');
      it('must reject registration for a domain name, which lacks MX record');
    });

    describe('#challenge', function challengeSuite() {
      it('must fail to send a challenge for a non-existing user');
      it('must be able to send challenge email');
      it('must fail to send challenge email more than once in an hour per user');
      it('must validate MX record for a domain before sending an email');
    });

    describe('#activate', function activateSuite() {
      it('must reject activation when challenge token is invalid');
      it('must reject activation when challenge token is expired');
      it('must activate account when challenge token is correct and not expired');
      it('must activate account when no challenge token is specified as a service action');
    });

    describe('#login', function loginSuite() {
      it('must reject login on a non-existing username');
      it('must reject login on an invalid password');
      it('must reject login on an inactive account');
      it('must reject login on a banned account');
      it('must login on a valid account with correct credentials');
      it('must return User object and JWT token on login similar to #register+activate');
      it('must reject lock account for authentication after 3 invalid login attemps');
      it('must reset authentication attemps after resetting password');
    });

    describe('#logout', function logoutSuite() {
      it('must reject logout on an invalid JWT token');
      it('must delete JWT token from pool of valid tokens');
    });

    describe('#verify', function verifySuite() {
      it('must reject on an invalid JWT token');
      it('must reject on an expired JWT token');
      it('must return user object on a valid JWT token');
      it('must return user object and associated metadata on a valid JWT token with default audience');
      it('must return user object and associated metadata on a valid JWT token with provided audiences');
    });

    describe('#getMetadata', function getMetadataSuite() {
      it('must reject to return metadata on a non-existing username');
      it('must return metadata for a default audience of an existing user');
      it('must return metadata for default and passed audiences of an existing user');
    });

    describe('#updateMetadata', function getMetadataSuite() {
      it('must reject updating metadata on a non-existing user');
      it('must be able to add metadata for a single audience of an existing user');
      it('must be able to remove metadata for a single audience of an existing user');
      it('must be able to perform batch add/remove operations for a single audience of an existing user');
    });

    describe('#requestPassword', function requestPasswordSuite() {
      it('must reject for a non-existing user');
      it('must send challenge email for an existing user');
      it('must reject sending reset password emails for an existing user more than once in 3 hours');
    });

    describe('#updatePassword', function updatePasswordSuite() {
      it('must reject updating password for a non-existing user');
      it('must reject updating password for an invalid challenge token');
      it('must update password passed with a valid challenge token');
      it('must fail to update password with a valid challenge token, when it doesn\'t conform to password requirements');
      it('must reset login attemts for a user after resetting password');
    });

    describe('#ban', function banSuite() {
      it('must reject banning a non-existing user');
      it('must reject (un)banning a user without action being implicitly set');
      it('must ban an existing user');
      it('must unban an existing user');
      it('must fail to unban not banned user');
      it('must fail to ban already banned user');
    });
  });
});
