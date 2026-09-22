#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { type DeployEnv, GithubCiStack } from '../lib/github-ci-stack';

const ACCOUNTS: Record<DeployEnv, string> = {
  sandbox: '975050268859',
  prod: '637423226886',
};

const raw = process.env.NPM_ENVIRONMENT;
if (raw !== 'sandbox' && raw !== 'prod') {
  throw new Error(
    `NPM_ENVIRONMENT must be set to "sandbox" or "prod", got ${JSON.stringify(raw)}. ` +
      'Use the deploy-sandbox / deploy-prod scripts rather than calling cdk directly.',
  );
}
const deployEnv: DeployEnv = raw;

const app = new cdk.App();

new GithubCiStack(app, 'GithubCiStack', {
  deployEnv,
  owner: 'nakomis',
  ownerId: '1488244',
  repo: 'cthulhu',
  repoId: '1381430098',
  env: { account: ACCOUNTS[deployEnv], region: 'eu-west-2' },
  stackName: `cthulhu-github-ci-${deployEnv}`,
});
