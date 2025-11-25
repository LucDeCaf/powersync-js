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

import { findWorkspacePackages } from '@pnpm/workspace.find-packages';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

enum TestState {
  PASSED = 'passed',
  FAILED = 'failed',
  WARN = 'warn'
}

type TestResult = {
  name: string;
  state: TestState;
  error?: string;
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
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const updateDeps = (deps: { [key: string]: string }) => {
    for (const dep in deps) {
      const matchingPackage = workspacePackages.find((p) => p.manifest.name === dep);
      if (matchingPackage != undefined) {
        deps[dep] = 'workspace:*';
      }
    }
  };

  if (packageJson.dependencies) {
    updateDeps(packageJson.dependencies);
  }

  if (packageJson.devDependencies) {
    updateDeps(packageJson.devDependencies);
  }

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
};

// Function to process each demo
const buildDemo = async (demoName: string): Promise<TestResult> => {
  const demoSrc = path.join(demosDir, demoName);

  console.log(`Processing ${demoName}`);

  const result: TestResult = {
    name: demoName,
    state: TestState.WARN
  };

  // Ensure node_modules is present
  const nodeModulesPath = path.join(demoSrc, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    result.state = TestState.FAILED;
    result.error = 'File not found';
    return result;
  }

  // Run pnpm build
  const packageJsonPath = path.join(demoSrc, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  if (!pkg.scripts['test:build']) {
    result.state = TestState.WARN;
    return result;
  }

  try {
    if (pkg.scripts['prepare:isolated:test']) {
      execSync('pnpm run prepare:isolated:test', { cwd: demoSrc, stdio: 'inherit' });
    }

    execSync('pnpm run test:build', { cwd: demoSrc, stdio: 'inherit' });
    result.state = TestState.PASSED;
  } catch (ex) {
    result.state = TestState.FAILED;
    result.error = ex.message;
  }

  return result;
};

// Main function to read demos directory and process each demo
const main = async () => {
  const buildResults: TestResult[] = [];

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
    const allDemos = fs.readdirSync(demosDir);
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

    console.log('Installing packages...');
    try {
      execSync('pnpm install', { stdio: 'inherit' });
    } catch (e) {
      console.error(`Error installing packages: ${e}`);
      process.exit(1);
    }
    console.log('Done.\n');

    if (opts.noBuild) {
      process.exit(0);
    }

    console.log('Processing demos...');
    for (const demoName of demoNames) {
      try {
        buildResults.push(await buildDemo(demoName));
      } catch (ex) {
        buildResults.push({
          name: demoName,
          state: TestState.FAILED,
          error: ex.message
        });
        console.log(`::error file=${demoName},line=1,col=1::${ex}`);
      }
    }
  } catch (err) {
    console.error(`Error processing demos: ${err}`);
    process.exit(1);
  }

  const errored = !!buildResults.find((r) => r.state == TestState.FAILED);

  for (const res of buildResults) {
    const state = displayState(res.state);
    if (res.error) {
      console.log(`${res.name}: ${state}: ${res.error}`);
    } else {
      console.log(`${res.name}: ${state}`);
    }
  }

  if (errored) {
    console.error(`Some demos did not pass`);
    process.exit(1);
  } else {
    console.log('All demos processed successfully.');
  }
};

main();
