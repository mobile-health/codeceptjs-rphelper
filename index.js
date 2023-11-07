const RPClient = require("@reportportal/client-javascript");
const fs = require("fs");
const path = require("path");
const debug = require("debug")("codeceptjs:reportportal");
const { isMainThread } = require("worker_threads");
const { clearString } = require("codeceptjs/lib/utils");
const { inspect } = require("util");

const { event, recorder, output, container } = codeceptjs;

const helpers = container.helpers();
let helper;
let isControlThread;

const rp_FAILED = "FAILED";
const rp_PASSED = "PASSED";
const rp_SUITE = "SUITE";
const rp_TEST = "TEST";
const rp_STEP = "STEP";

const screenshotHelpers = ["WebDriver", "Appium", "Puppeteer", "TestCafe", "Playwright"];

for (const helperName of screenshotHelpers) {
  if (Object.keys(helpers).indexOf(helperName) > -1) {
    helper = helpers[helperName];
    break;
  }
}

const mobileHelper = helpers["MobileDriver"];

const defaultConfig = {
  apiKey: "",
  endpoint: "",
  project: "",
  launchDescription: "",
  attributes: [],
  debug: false,
  rerun: undefined,
  enabled: false,
};

module.exports = (config) => {
  config = Object.assign(defaultConfig, config);

  let launchObj;
  let suiteObj;
  let testObj;
  let rpClient;

  const launchStatus = rp_PASSED;
  let currentMetaSteps = [];

  const suiteArr = new Set();
  let testArr = [];
  const stepArr = [];

  event.dispatcher.on(event.suite.before, (suite) => {
    suiteArr.add(suite.title);
  });

  event.dispatcher.on(event.step.failed, (step, err) => {
    stepArr.push(step);
  });

  event.dispatcher.on(event.step.passed, (step, err) => {
    stepArr.push(step);
  });

  event.dispatcher.on(event.test.failed, async (test, err) => {
    testArr.push(test);
  });

  event.dispatcher.on(event.test.passed, (test) => {
    testArr.push(test);
  });

  event.dispatcher.on(event.test.started, (test) => {
    output.debug(`test.started - ${inspect(test)}`);
    recorder.add(async () => {
      await mobileHelper.startRecord();
    });
  });

  event.dispatcher.on(event.test.finished, (test) => {
    output.debug(`test.finished - ${inspect(test)}`);
    recorder.add(async () => {
      await mobileHelper.stopRecord(getRecordTestFile(test.uid));
    });
  });

  function getRecordTestFile(testId) {
    return `./output/record-test-${testId}.mp4`;
  }

  async function startTestItem(launchId, testTitle, method, parentId = null) {
    try {
      const hasStats = method !== rp_STEP;
      return rpClient.startTestItem(
        {
          name: testTitle,
          type: method,
          hasStats,
        },
        launchId,
        parentId,
      );
    } catch (error) {
      console.log(error);
    }
  }

  event.dispatcher.on(event.workers.result, async (result) => {
    recorder.add(async () => {
      await _sendResultsToRP(result);
    });
  });

  event.dispatcher.on(event.all.result, async () => {
    if (!process.env.RUNS_WITH_WORKERS) {
      recorder.add(async () => {
        await _sendResultsToRP();
      });
    }
  });

  async function _sendResultsToRP(result) {
    output.debug(`_sendResultsToRP result = ${inspect(result)}`);

    if (result) {
      for (suite of result.suites) {
        suiteArr.add(suite.title);
      }
      testArr = result.tests;
    }

    launchObj = await startLaunch();
    await launchObj.promise;

    const suiteTempIdArr = [];
    const testTempIdArr = [];

    for (suite of suiteArr) {
      suiteObj = await startTestItem(launchObj.tempId, suite, rp_SUITE);
      suiteObj.status = rp_PASSED;
      suiteTempIdArr.push({
        suiteTitle: suite,
        suiteTempId: suiteObj.tempId,
      });
      await finishStepItem(suiteObj);
    }

    output.debug(`testArr = ${inspect(testArr)}`);
    if (process.env.RUNS_WITH_WORKERS) {
      for (test of testArr.passed) {
        testObj = await startTestItem(
          launchObj.tempId,
          test.title,
          rp_TEST,
          suiteTempIdArr.find((element) => element.suiteTitle === test.parent.title).suiteTempId,
        );
        testObj.status = rp_PASSED;

        testTempIdArr.push({
          testTitle: test.title,
          testTempId: testObj.tempId,
          testError: test.err,
          testSteps: test.steps,
        });

        await finishStepItem(testObj);
      }

      for (test of testArr.failed) {
        testObj = await startTestItem(
          launchObj.tempId,
          test.title,
          rp_TEST,
          suiteTempIdArr.find((element) => element.suiteTitle === test.parent.title).suiteTempId,
        );
        testObj.status = rp_FAILED;

        testTempIdArr.push({
          testTitle: test.title,
          testTempId: testObj.tempId,
          testError: test.err,
          testSteps: test.steps,
        });

        await finishStepItem(testObj);
      }
    } else {
      for (test of testArr) {
        testObj = await startTestItem(
          launchObj.tempId,
          test.title,
          rp_TEST,
          suiteTempIdArr.find((element) => element.suiteTitle === test.parent.title).suiteTempId,
        );
        testObj.status = rp_FAILED;

        testTempIdArr.push({
          testTitle: test.title,
          testTempId: testObj.tempId,
          testError: test.err,
          testSteps: test.steps,
        });
        let recordFile = getRecordTestFile(test.uid);
        if (fs.existsSync(recordFile)) {
          let recordBody = await attachScreenRecord(recordFile);
          await sendLogToRP({
            tempId: testObj.tempId,
            level: "debug",
            message: "Screen record",
            screenshotData: recordBody,
          });
          output.debug(`send record file success - ${recordFile}`);
        }

        await finishStepItem(testObj);
      }
    }

    for (test of testTempIdArr) {
      for (step of test.testSteps) {
        output.debug(`step = \n${inspect(step)}`)
        let args = step.args ? step.args : {}
        args = JSON.stringify(args)
        const stepTitle = `[STEP] - ${step.actor} ${step.name} ${args}`;
        const stepObj = await startTestItem(launchObj.tempId, stepTitle, rp_STEP, test.testTempId);
        stepObj.status = step.status || rp_PASSED;
        await finishStepItem(stepObj);

        if (stepObj.status === "failed" && step.err) {
          await sendLogToRP({
            tempId: stepObj.tempId,
            level: "ERROR",
            message: `[FAILED STEP] - ${step.err.stack ? step.err.stack : JSON.stringify(step.err)}`,
          });
          await sendLogToRP({
            tempId: stepObj.tempId,
            level: "debug",
            message: "Last seen screenshot",
            screenshotData: await attachScreenshot(`${clearString(test.testTitle)}.failed.png`),
          });
        }

        if (stepObj.status === "failed" && step.test.err) {
          await sendLogToRP({
            tempId: stepObj.tempId,
            level: "ERROR",
            message: `[FAILED STEP] - ${JSON.stringify(step.test.err)}`,
          });
          await sendLogToRP({
            tempId: stepObj.tempId,
            level: "debug",
            message: "Last seen screenshot",
            screenshotData: await attachScreenshot(`${clearString(test.testTitle)}.failed.png`),
          });
        }
      }
    }

    await finishLaunch();
  }

  function startLaunch(suiteTitle) {
    rpClient = new RPClient({
      token: config.token,
      endpoint: config.endpoint,
      project: config.projectName,
      debug: config.debug,
    });

    const launchOpts = {
      name: config.launchName || suiteTitle,
      description: config.launchDescription,
      attributes: config.launchAttributes,
      rerun: config.rerun,
      rerunOf: config.rerunOf,
    };

    return rpClient.startLaunch(launchOpts);
  }

  async function sendLogToRP({ tempId, level, message, screenshotData }) {
    return rpClient.sendLog(
      tempId,
      {
        level,
        message,
      },
      screenshotData,
    ).promise;
  }

  async function attachScreenRecord(fileName) {
    if (!mobileHelper) return undefined;

    let content;

    if (fileName) {
      try {
        content = fs.readFileSync(fileName);
        fs.unlinkSync(fileName);
      } catch (err) {
        output.error("Couldn't find screenRecord");
        return undefined;
      }
    }

    return {
      name: clearString(fileName),
      type: "video/mp4",
      content,
    };
  }

  async function attachScreenshot(fileName) {
    if (!helper) return undefined;
    let content;

    if (!fileName) {
      fileName = `${rpClient.helpers.now()}_failed.png`;
      try {
        await helper.saveScreenshot(fileName);
        content = fs.readFileSync(path.join(global.output_dir, fileName));
        fs.unlinkSync(path.join(global.output_dir, fileName));
      } catch (err) {
        output.error("Couldn't save screenshot");
        return undefined;
      }
    } else {
      content = fs.readFileSync(path.join(global.output_dir, fileName));
    }

    return {
      name: fileName,
      type: "image/png",
      content,
    };
  }

  async function finishLaunch() {
    try {
      debug(`${launchObj.tempId} Finished launch: ${launchStatus}`);
      let result = await rpClient.finishLaunch(launchObj.tempId, {
        status: launchStatus,
        endTime: rpClient.helpers.now(),
      }).promise;
      output.debug(`sendLaunch result = ${inspect(result)}`);
      fs.writeFile(
        "../test_result_env.sh",
        `
          export REPORT_PORTAL_RESULT_LINK="${result.link}"
        `,
        function (err) {
          if (err) throw err;
        },
      );
    } catch (error) {
      output.debug(`finishLaunch error : ${inspect(error)}`);
      debug(error);
    }
  }

  async function startMetaSteps(step) {
    let metaStepObj = {};
    const metaSteps = metaStepsToArray(step.metaStep);

    for (const i in metaSteps) {
      const metaStep = metaSteps[i];
      if (isEqualMetaStep(metaStep, currentMetaSteps[i])) {
        continue;
      }
      // close current metasteps
      for (let j = i; j < currentMetaSteps.length; j++) {
        await finishStepItem(currentMetaSteps[j]);
        delete currentMetaSteps[j];
      }

      metaStepObj = currentMetaSteps[currentMetaSteps.length - 1] || {};

      const isNested = !!metaStepObj.tempId;
      metaStepObj = startTestItem(metaStep.toString(), rp_STEP, metaStepObj.tempId || testObj.tempId);
      metaStep.tempId = metaStepObj.tempId;
      debug(`${metaStep.tempId}: The stepId '${metaStep.toString()}' is started. Nested: ${isNested}`);
    }

    currentMetaSteps = metaSteps;
    return currentMetaSteps[currentMetaSteps.length - 1] || testObj;
  }

  function finishStepItem(step) {
    if (!step) return;

    debug(`Finishing '${step.toString()}' step`);

    return rpClient.finishTestItem(step.tempId, {
      endTime: rpClient.helpers.now(),
      status: rpStatus(step.status),
    });
  }

  return this;
};

function metaStepsToArray(step) {
  const metaSteps = [];
  iterateMetaSteps(step, (metaStep) => metaSteps.push(metaStep));
  return metaSteps;
}

function iterateMetaSteps(step, fn) {
  if (step.metaStep) iterateMetaSteps(step.metaStep, fn);
  if (step) fn(step);
}

const isEqualMetaStep = (metastep1, metastep2) => {
  if (!metastep1 && !metastep2) return true;
  if (!metastep1 || !metastep2) return false;
  return (
    metastep1.actor === metastep2.actor &&
    metastep1.name === metastep2.name &&
    metastep1.args.join(",") === metastep2.args.join(",")
  );
};

function rpStatus(status) {
  if (status === "success") return rp_PASSED;
  if (status === "failed") return rp_FAILED;
  return status;
}
