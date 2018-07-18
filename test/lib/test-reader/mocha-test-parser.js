'use strict';

const path = require('path');
const _ = require('lodash');
const proxyquire = require('proxyquire').noCallThru();
const crypto = require('lib/utils/crypto');
const SkipBuilder = require('lib/test-reader/skip/skip-builder');
const OnlyBuilder = require('lib/test-reader/skip/only-builder');
const Skip = require('lib/test-reader/skip/');
const TestSkipper = require('lib/test-reader/test-skipper');
const RunnerEvents = require('lib/constants/runner-events');
const ParserEvents = require('lib/test-reader/parser-events');
const SuiteSubset = require('lib/test-reader/suite-subset');
const TestParserAPI = require('lib/test-reader/test-parser-api');
const MochaStub = require('../_mocha');

describe('test-reader/mocha-test-parser', () => {
    const sandbox = sinon.sandbox.create();

    let MochaTestParser;
    let clearRequire;
    let testSkipper;

    const mkMochaTestParser_ = (opts = {}) => {
        const browserId = opts.browserId || 'default-bro';
        const config = opts.config || {};

        return MochaTestParser.create(browserId, config);
    };

    beforeEach(() => {
        testSkipper = sinon.createStubInstance(TestSkipper);

        clearRequire = sandbox.stub().named('clear-require');

        sandbox.stub(crypto, 'getShortMD5');

        MochaTestParser = proxyquire('../../../lib/test-reader/mocha-test-parser', {
            'clear-require': clearRequire,
            'mocha': MochaStub
        });
    });

    afterEach(() => sandbox.restore());

    describe('prepare', () => {
        afterEach(() => delete global.hermione);

        it('should add an empty hermione object to global', () => {
            MochaTestParser.prepare();

            assert.deepEqual(global.hermione, {});
        });

        it('should do nothing if hermione is already in a global', () => {
            global.hermione = {some: 'data'};

            MochaTestParser.prepare();

            assert.deepEqual(global.hermione, {some: 'data'});
        });
    });

    describe('constructor', () => {
        afterEach(() => delete global.hermione);

        it('should pass shared opts to mocha instance', () => {
            mkMochaTestParser_({
                config: {
                    mochaOpts: {grep: 'foo'}
                }
            });

            assert.deepEqual(MochaStub.lastInstance.constructorArgs, {grep: 'foo'});
        });

        it('should enable full stacktrace in mocha', () => {
            mkMochaTestParser_();

            assert.called(MochaStub.lastInstance.fullTrace);
        });

        it('should create test parser API object', () => {
            sandbox.spy(TestParserAPI, 'create');
            global.hermione = {foo: 'bar'};

            const testParser = mkMochaTestParser_();

            assert.calledOnceWith(TestParserAPI.create, testParser, global.hermione);
        });
    });

    describe('loadFiles', () => {
        it('should be chainable', () => {
            const mochaTestParser = mkMochaTestParser_();

            assert.deepEqual(mochaTestParser.loadFiles(['path/to/file']), mochaTestParser);
        });

        it('should load files', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.loadFiles(['path/to/file']);

            assert.calledOnceWith(MochaStub.lastInstance.addFile, 'path/to/file');
        });

        it('should load a single file', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.loadFiles('path/to/file');

            assert.calledOnceWith(MochaStub.lastInstance.addFile, 'path/to/file');
        });

        it('should clear require cache for file before adding', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.loadFiles(['path/to/file']);

            assert.calledOnceWith(clearRequire, path.resolve('path/to/file'));
            assert.callOrder(clearRequire, MochaStub.lastInstance.addFile);
        });

        it('should load file after add', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.loadFiles(['path/to/file']);

            assert.calledOnce(MochaStub.lastInstance.loadFiles);
            assert.callOrder(MochaStub.lastInstance.addFile, MochaStub.lastInstance.loadFiles);
        });

        it('should flush files after load', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.loadFiles(['path/to/file']);

            assert.deepEqual(MochaStub.lastInstance.files, []);
        });

        it('should throw in case of duplicate test titles in different files', () => {
            const mochaTestParser = mkMochaTestParser_();

            MochaStub.lastInstance.loadFiles.callsFake(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => {
                    return suite
                        .addTest({title: 'some test', file: 'first file'})
                        .addTest({title: 'some test', file: 'second file'});
                });
            });

            assert.throws(() => mochaTestParser.loadFiles([]),
                'Tests with the same title \'some test\' in files \'first file\' and \'second file\' can\'t be used');
        });

        it('should throw in case of duplicate test titles in the same file', () => {
            const mochaTestParser = mkMochaTestParser_();

            MochaStub.lastInstance.loadFiles.callsFake(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => {
                    return suite
                        .addTest({title: 'some test', file: 'some file'})
                        .addTest({title: 'some test', file: 'some file'});
                });
            });

            assert.throws(() => mochaTestParser.loadFiles([]),
                'Tests with the same title \'some test\' in file \'some file\' can\'t be used');
        });

        it('should emit TEST event on test creation', () => {
            const onTest = sinon.spy().named('onTest');
            const mochaTestParser = mkMochaTestParser_()
                .on(ParserEvents.TEST, onTest);

            const test = MochaStub.Test.create();

            MochaStub.lastInstance.loadFiles.callsFake(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(test));
            });

            mochaTestParser.loadFiles([]);

            assert.calledOnceWith(onTest, test);
        });

        it('should emit SUITE event on suite creation', () => {
            const onSuite = sinon.spy().named('onSuite');
            const mochaTestParser = mkMochaTestParser_()
                .on(ParserEvents.SUITE, onSuite);

            const nestedSuite = MochaStub.Suite.create();

            MochaStub.lastInstance.loadFiles.callsFake(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addSuite(nestedSuite));
            });

            mochaTestParser.loadFiles([]);

            assert.calledOnceWith(onSuite, nestedSuite);
        });
    });

    describe('hermione global', () => {
        beforeEach(() => MochaTestParser.prepare());
        afterEach(() => delete global.hermione);

        it('hermione.skip should return SkipBuilder instance', () => {
            mkMochaTestParser_();

            assert.instanceOf(global.hermione.skip, SkipBuilder);
        });

        it('hermione.only should return OnlyBuilder instance', () => {
            mkMochaTestParser_();

            assert.instanceOf(global.hermione.only, OnlyBuilder);
        });

        it('hermione.ctx should return passed ctx', () => {
            mkMochaTestParser_({
                config: {
                    ctx: {some: 'ctx'}
                }
            });

            assert.deepEqual(global.hermione.ctx, {some: 'ctx'});
        });
    });

    describe('forbid suite hooks', () => {
        beforeEach(() => mkMochaTestParser_());

        it('should throw in case of "before" hook', () => {
            assert.throws(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => suite.beforeAll(() => {}));
            }, '"before" and "after" hooks are forbidden, use "beforeEach" and "afterEach" hooks instead');
        });

        it('should throw in case of "after" hook', () => {
            assert.throw(() => {
                MochaStub.lastInstance.updateSuiteTree((suite) => suite.afterAll(() => {}));
            }, '"before" and "after" hooks are forbidden, use "beforeEach" and "afterEach" hooks instead');
        });
    });

    describe('inject skip', () => {
        let mochaTestParser;

        beforeEach(() => {
            sandbox.stub(Skip.prototype, 'handleEntity');

            mochaTestParser = mkMochaTestParser_();
        });

        it('should apply skip to test', () => {
            const test = new MochaStub.Test();

            MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(test));

            mochaTestParser.parse();

            assert.called(Skip.prototype.handleEntity);
            assert.calledWith(Skip.prototype.handleEntity, test);
        });

        it('should apply skip to suite', () => {
            const nestedSuite = MochaStub.Suite.create();

            MochaStub.lastInstance.updateSuiteTree((suite) => suite.addSuite(nestedSuite));

            mochaTestParser.parse();

            assert.called(Skip.prototype.handleEntity);
            assert.calledWith(Skip.prototype.handleEntity, nestedSuite);
        });
    });

    describe('extend suite API', () => {
        describe('id', () => {
            it('should be added to suite', () => {
                mkMochaTestParser_();

                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addSuite(MochaStub.Suite.create()));

                const suite = MochaStub.lastInstance.suite.suites[0];

                assert.isFunction(suite.id);
            });

            it('should generate uniq suite id', () => {
                crypto.getShortMD5.withArgs('/some/file.js').returns('12345');

                mkMochaTestParser_();

                MochaStub.lastInstance.suite.emit('pre-require', {}, '/some/file.js');

                MochaStub.lastInstance.updateSuiteTree((suite) => {
                    return suite
                        .addSuite(MochaStub.Suite.create())
                        .addSuite(MochaStub.Suite.create());
                });

                const suite1 = MochaStub.lastInstance.suite.suites[0];
                const suite2 = MochaStub.lastInstance.suite.suites[1];

                assert.equal(suite1.id(), '123450');
                assert.equal(suite2.id(), '123451');
            });
        });
    });

    describe('applySkip', () => {
        it('should skip suite using test skipper', () => {
            const mochaTestParser = mkMochaTestParser_({browserId: 'some-browser'});

            mochaTestParser.applySkip(testSkipper);

            assert.calledWith(testSkipper.applySkip, MochaStub.lastInstance.suite, 'some-browser');
        });

        it('should be chainable', () => {
            const mochaTestParser = mkMochaTestParser_();
            const mochaInstance = mochaTestParser.applySkip(testSkipper);

            assert.instanceOf(mochaInstance, MochaTestParser);
        });
    });

    describe('applyGrep', () => {
        it('should add grep to mocha', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.applyGrep('foo bar');

            assert.calledOnceWith(MochaStub.lastInstance.grep, 'foo bar');
        });

        it('should not add empty grep to mocha', () => {
            const mochaTestParser = mkMochaTestParser_();

            mochaTestParser.applyGrep();
            mochaTestParser.applyGrep('');

            assert.notCalled(MochaStub.lastInstance.grep);
        });

        it('should be chainable', () => {
            const mochaTestParser = mkMochaTestParser_();
            const mochaInstance = mochaTestParser.applyGrep('foo bar');

            assert.instanceOf(mochaInstance, MochaTestParser);
        });
    });

    describe('extend test API', () => {
        it('should add "id" method for test', () => {
            mkMochaTestParser_();
            MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(new MochaStub.Test()));

            const test = MochaStub.lastInstance.suite.tests[0];

            assert.isFunction(test.id);
        });

        it('should generate uniq id for test by calling "id" method', () => {
            crypto.getShortMD5.returns('12345');
            mkMochaTestParser_();
            MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(new MochaStub.Test()));

            const test = MochaStub.lastInstance.suite.tests[0];

            assert.equal(test.id(), '12345');
        });

        it('shold set browserId property to test', () => {
            mkMochaTestParser_({browserId: 'bro'});
            MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(new MochaStub.Test()));

            const test = MochaStub.lastInstance.suite.tests[0];

            assert.equal(test.browserId, 'bro');
        });
    });

    describe('extend hook API', () => {
        it('shold set browserId property to beforeEach hook', () => {
            mkMochaTestParser_({browserId: 'bro'});
            MochaStub.lastInstance.updateSuiteTree((suite) => suite.beforeEach(() => {}));

            const hook = MochaStub.lastInstance.suite.beforeEachHooks[0];

            assert.propertyVal(hook, 'browserId', 'bro');
        });

        it('shold set browserId property to afterEach hook', () => {
            mkMochaTestParser_({browserId: 'bro'});
            MochaStub.lastInstance.updateSuiteTree((suite) => suite.afterEach(() => {}));

            const hook = MochaStub.lastInstance.suite.afterEachHooks[0];

            assert.propertyVal(hook, 'browserId', 'bro');
        });
    });

    describe('passthrough mocha file events', () => {
        beforeEach(() => {
            MochaTestParser.init();
        });

        afterEach(() => delete global.hermione);

        _.forEach({
            'pre-require': 'BEFORE_FILE_READ',
            'post-require': 'AFTER_FILE_READ'
        }, (hermioneEvent, mochaEvent) => {
            it(`should emit ${hermioneEvent} on mocha ${mochaEvent}`, () => {
                const onEvent = sinon.stub().named(`on${hermioneEvent}`);
                mkMochaTestParser_({browserId: 'bro'})
                    .on(RunnerEvents[hermioneEvent], onEvent);

                MochaStub.lastInstance.suite.emit(mochaEvent, {}, '/some/file.js');

                assert.calledOnceWith(onEvent, sinon.match({
                    file: '/some/file.js',
                    hermione: global.hermione,
                    browser: 'bro'
                }));
            });
        });

        it('should emit BEFORE_FILE_READ with mocha root suite subset', () => {
            const onBeforeFileRead = sinon.stub().named('onBeforeFileRead');
            const mochaTestParser = mkMochaTestParser_()
                .on(RunnerEvents.BEFORE_FILE_READ, onBeforeFileRead);

            const suiteSubset = SuiteSubset.create(mochaTestParser.suite, '/some/file.js');
            sandbox.stub(SuiteSubset, 'create')
                .withArgs(mochaTestParser.suite, '/some/file.js').returns(suiteSubset);

            MochaStub.lastInstance.suite.emit('pre-require', {}, '/some/file.js');

            assert.calledOnceWith(onBeforeFileRead, sinon.match({
                suite: suiteSubset
            }));
        });

        it('should emit BEFORE_FILE_READ and AFTER_FILE_READ with the same mocha root suite subset', () => {
            const onBeforeFileRead = sinon.stub().named('onBeforeFileRead');
            const onAfterFileRead = sinon.stub().named('onAfterFileRead');
            mkMochaTestParser_()
                .on(RunnerEvents.BEFORE_FILE_READ, onBeforeFileRead)
                .on(RunnerEvents.AFTER_FILE_READ, onAfterFileRead);

            MochaStub.lastInstance.suite.emit('pre-require', {}, '/some/file.js');
            MochaStub.lastInstance.suite.emit('post-require', {}, '/some/file.js');

            assert.equal(
                onBeforeFileRead.firstCall.args[0].suite,
                onAfterFileRead.firstCall.args[0].suite
            );
        });

        it('should emit different mocha root suite subsets for different files', () => {
            const onBeforeFileRead = sinon.stub().named('onBeforeFileRead');
            mkMochaTestParser_()
                .on(RunnerEvents.BEFORE_FILE_READ, onBeforeFileRead);

            MochaStub.lastInstance.suite.emit('pre-require', {}, '/some/file.js');
            MochaStub.lastInstance.suite.emit('pre-require', {}, '/other/file.js');

            assert.notEqual(
                onBeforeFileRead.firstCall.args[0].suite,
                onBeforeFileRead.secondCall.args[0].suite
            );
        });

        it('should emit BEFORE_FILE_READ with test parser API', () => {
            const onBeforeFileRead = sinon.stub().named('onBeforeFileRead');
            mkMochaTestParser_()
                .on(RunnerEvents.BEFORE_FILE_READ, onBeforeFileRead);

            MochaStub.lastInstance.suite.emit('pre-require', {}, '/some/file.js');

            assert.calledOnceWith(onBeforeFileRead, sinon.match({
                testParser: sinon.match.instanceOf(TestParserAPI)
            }));
        });
    });

    describe('parse', () => {
        it('should resolve with test list', () => {
            const mochaTestParser = mkMochaTestParser_();

            const test1 = new MochaStub.Test();
            const test2 = new MochaStub.Test();

            MochaStub.lastInstance.updateSuiteTree((suite) => {
                return suite
                    .addTest(test1)
                    .addTest(test2);
            });

            const tests = mochaTestParser.parse();

            assert.deepEqual(tests, [test1, test2]);
        });

        it('should resolve also with pending tests', () => {
            const mochaTestParser = mkMochaTestParser_();

            const test = new MochaStub.Test();
            test.pending = true;

            MochaStub.lastInstance.updateSuiteTree((suite) => {
                return suite
                    .addTest(test);
            });

            const tests = mochaTestParser.parse();

            assert.deepEqual(tests, [test]);
        });

        describe('grep', () => {
            it('should disable tests not matching to grep pattern', () => {
                const mochaTestParser = mkMochaTestParser_();

                const test = new MochaStub.Test(null, {title: 'test title'});

                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(test));

                const tests = mochaTestParser
                    .applyGrep('foo')
                    .parse();

                assert.isTrue(Boolean(tests[0].pending));
                assert.isTrue(Boolean(tests[0].silentSkip));
            });

            it('should not disable tests matching to grep pattern', () => {
                const mochaTestParser = mkMochaTestParser_();

                const test = new MochaStub.Test(null, {title: 'test title'});

                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(test));

                const tests = mochaTestParser
                    .applyGrep('test title')
                    .parse();

                assert.isFalse(Boolean(tests[0].pending));
                assert.isFalse(Boolean(tests[0].silentSkip));
            });

            it('should not enable disabled tests', () => {
                const mochaTestParser = mkMochaTestParser_();

                const test = new MochaStub.Test(null, {
                    title: 'test title',
                    pending: true,
                    silentSkip: true
                });

                MochaStub.lastInstance.updateSuiteTree((suite) => suite.addTest(test));

                const tests = mochaTestParser
                    .applyGrep('test title')
                    .parse();

                assert.isTrue(Boolean(tests[0].pending));
                assert.isTrue(Boolean(tests[0].silentSkip));
            });
        });
    });
});
