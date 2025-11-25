/**
 * Users want to be able to run 'pnpm build:packages', cd into a demo,
 * run 'pnpm install && pnpm build', and have just that demo's packages
 * installed. Currently, this is not possible, as demos are included in
 * the pnpm workspace and therefore all demos' packages will be installed.
 *
 * This script goes through every package in 'demos/*' and replaces the
 * workspace packages' versions with 'workspace:*', allowing for easy
 * testing of new versions for SDK developers, as well as small
 * node_modules folders for SDK users.
 *
 * This way, users can use 'pnpm --ignore-workspace install && pnpm build',
 * while SDK devs can use 'tsx ./scripts/link-demos.ts' to build demos.
 *
 * Most of this code is copied from './scripts/isolated-demo-test.ts'.
 */

import * as core from '@actions/core';
import { findWorkspacePackages } from '@pnpm/workspace.find-packages';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

enum TestState {
  PASSED = 'passed',
  FAILED = 'failed',
  WARN = 'warn'
}

type TestResult = {
  state: TestState;
  error?: string;
};

type DemoResult = {
  name: string;
  installResult: TestResult;
  buildResult: TestResult;
};

const displayState = (state: TestState) => {
  switch (state) {
    case TestState.PASSED:
      return `Pass ✅`;
    case TestState.FAILED:
      return `Fail ❌`;
    case TestState.WARN:
      return `Pass ⚠️`;
  }
};

const demosDir = path.resolve('demos');

const workspacePackages = await findWorkspacePackages(path.resolve('.'));

// Function to split user-provided demos into found and not found demos
const filterDemos = (allDemos: string[], providedDemos: string[]): [string[], string[]] => {
  const found: string[] = [];
  const notFound: string[] = [];

  providedDemos.forEach((demo) => {
    if (allDemos.includes(demo)) {
      found.push(demo);
    } else {
      notFound.push(demo);
    }
  });

  return [found, notFound];
};

// Function to replace '^x.xx.xx' with 'workspace:*' for workspace packages
const linkDemo = async (demoName: string) => {
  const demoSrc = path.join(demosDir, demoName);
  console.log(`Linking ${demoName}`);

  // Update package.json
  const packageJsonPath = path.join(demoSrc, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  const updateDeps = async (deps: { [key: string]: string }) => {
    for (const dep in deps) {
      const matchingPackage = workspacePackages.find((p) => p.manifest.name === dep) != undefined;
      if (matchingPackage) {
        deps[dep] = 'workspace:*';
      }
    }
  };

  if (packageJson.dependencies) {
    await updateDeps(packageJson.dependencies);
  }

  if (packageJson.devDependencies) {
    await updateDeps(packageJson.devDependencies);
  }

  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
};

// Function to process each demo
const processDemo = async (demoName: string, installOnly: boolean): Promise<DemoResult> => {
  const demoSrc = path.join(demosDir, demoName);

  console.log(`Processing ${demoName}`);

  const result: DemoResult = {
    name: demoName,
    installResult: {
      state: TestState.WARN
    },
    buildResult: {
      state: TestState.WARN
    }
  };

  // Run pnpm install
  try {
    execSync('pnpm install', { cwd: demoSrc, stdio: 'inherit' });
    result.installResult.state = TestState.PASSED;
  } catch (ex) {
    result.installResult.state = TestState.FAILED;
    result.installResult.error = ex.message;
    return result;
  }

  if (installOnly) return result;

  // Run pnpm build
  const packageJsonPath = path.join(demoSrc, 'package.json');
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
  if (!pkg.scripts['test:build']) {
    result.buildResult.state = TestState.WARN;
    return result;
  }

  try {
    if (pkg.scripts['prepare:isolated:test']) {
      execSync('pnpm run prepare:isolated:test', { cwd: demoSrc, stdio: 'inherit' });
    }

    execSync('pnpm run test:build', { cwd: demoSrc, stdio: 'inherit' });
    result.buildResult.state = TestState.PASSED;
  } catch (ex) {
    result.buildResult.state = TestState.FAILED;
    result.buildResult.error = ex.message;
  }

  return result;
};

// Main function to read demos directory and process each demo
const main = async () => {
  const results: DemoResult[] = [];

  const args: string[] = [];
  const opts = {
    noBuild: false,
    noInstall: false
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--no-build') {
      opts.noBuild = true;
    } else if (arg === '--no-install') {
      opts.noInstall = true;
    } else {
      args.push(arg);
    }
  }

  try {
    const allDemos = await fs.readdir(demosDir);
    let demoNames: string[];

    if (args.length > 0) {
      const [foundDemos, notFoundDemos] = filterDemos(allDemos, process.argv.slice(2));

      if (notFoundDemos.length > 0) {
        console.log('⚠️ Warning: Failed to locate some demos:');
        for (const demo of notFoundDemos) {
          console.log(`   - ${demo}`);
        }
      }

      demoNames = foundDemos;
    } else {
      demoNames = allDemos;
    }

    console.log('Linking demos...');
    for (const demoName of demoNames) {
      linkDemo(demoName);
    }
    console.log('Done.\n');

    if (opts.noInstall) {
      process.exit(0);
    }

    console.log('Processing demos...');
    for (const demoName of demoNames) {
      try {
        results.push(await processDemo(demoName, opts.noBuild));
      } catch (ex) {
        results.push({
          name: demoName,
          installResult: {
            state: TestState.FAILED,
            error: ex.message
          },
          buildResult: {
            state: TestState.FAILED
          }
        });
        console.log(`::error file=${demoName},line=1,col=1::${ex}`);
      }
    }
  } catch (err) {
    console.error(`Error processing demos: ${err}`);
    process.exit(1);
  }

  const errored = !!results.find(
    (r) => r.installResult.state == TestState.FAILED || r.buildResult.state == TestState.FAILED
  );

  await core.summary
    .addHeading('Test Results')
    .addTable([
      [
        { data: 'Demo', header: true },
        { data: 'Install', header: true },
        { data: 'Build', header: true }
      ],
      ...results.map((r) => [r.name, displayState(r.installResult.state), displayState(r.buildResult.state)])
    ])
    .write();

  if (errored) {
    console.error(`Some demos did not pass`);
    process.exit(1);
  } else {
    console.log('All demos processed successfully.');
  }
};

main();
