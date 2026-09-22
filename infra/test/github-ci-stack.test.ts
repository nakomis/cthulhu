import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubCiStack } from '../lib/github-ci-stack';

function synth(deployEnv: 'sandbox' | 'prod', account: string): Template {
  const app = new cdk.App();
  const stack = new GithubCiStack(app, 'TestStack', {
    deployEnv,
    owner: 'nakomis',
    ownerId: '1488244',
    repo: 'cthulhu',
    repoId: '1381430098',
    env: { account, region: 'eu-west-2' },
  });
  return Template.fromStack(stack);
}

describe('GithubCiStack', () => {
  it('names the role to the nakomis-<repo>-github-ci-<env> convention', () => {
    synth('sandbox', '975050268859').hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'nakomis-cthulhu-github-ci-sandbox',
    });
  });

  it('trusts BOTH the immutable and the name-only OIDC subject forms', () => {
    // Pinning to only one form fails with an opaque AssumeRoleWithWebIdentity
    // error. This test is the guard against someone "tidying" the list.
    synth('sandbox', '975050268859').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:nakomis@1488244/cthulhu@1381430098:*',
                  'repo:nakomis/cthulhu:*',
                ],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('restricts the audience to sts.amazonaws.com', () => {
    synth('prod', '637423226886').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            }),
          }),
        ]),
      }),
    });
  });

  it.each([
    ['sandbox', '975050268859'],
    ['prod', '637423226886'],
  ] as const)(
    'grants %s execute-api against the tracker in the PROD account',
    (deployEnv, account) => {
      // The sandbox role is a cross-account caller, so it needs this identity
      // policy even though the tracker also has a resource allow-list.
      synth(deployEnv, account).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'execute-api:Invoke',
              Resource: 'arn:aws:execute-api:eu-west-2:637423226886:*/*/*/deployments/*',
            }),
          ]),
        }),
      });
    },
  );

  it('creates exactly one role, so nothing extra is granted by accident', () => {
    synth('sandbox', '975050268859').resourceCountIs('AWS::IAM::Role', 1);
  });
});
