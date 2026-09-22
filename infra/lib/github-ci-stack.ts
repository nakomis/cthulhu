import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export type DeployEnv = 'sandbox' | 'prod';

export interface GithubCiStackProps extends cdk.StackProps {
  deployEnv: DeployEnv;
  owner: string;
  ownerId: string;
  repo: string;
  repoId: string;
}

/**
 * The IAM role GitHub Actions assumes via OIDC.
 *
 * Cthulhu has no AWS runtime - it is a Docker container on Luke. This role
 * exists solely so CI can reach the shared deployment-version tracker at
 * api.infra.nakomis.com. See CTHU-1.
 */
export class GithubCiStack extends cdk.Stack {
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: GithubCiStackProps) {
    super(scope, id, props);

    const { deployEnv, owner, ownerId, repo, repoId } = props;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const role = new iam.Role(this, 'GithubCiRole', {
      roleName: `nakomis-${repo}-github-ci-${deployEnv}`,
      description: `GitHub Actions CI role for ${owner}/${repo} (${deployEnv})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // GitHub's OIDC subject now carries immutable ids:
        //   repo:OWNER@OWNER_ID/REPO@REPO_ID:CONTEXT
        // Older repos still present the name-only form. Which one you get
        // depends on when the repo was created, and use_immutable_subject does
        // not reliably tell you. A policy pinned to one form fails with an
        // opaque "Not authorized to perform sts:AssumeRoleWithWebIdentity"
        // after ~2 minutes of retries. StringLike takes a list, which is an OR,
        // so accept both. This repo presents the immutable form (verified
        // 2026-09-22 via the actions/oidc/customization/sub API).
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${owner}@${ownerId}/${repo}@${repoId}:*`,
            `repo:${owner}/${repo}:*`,
          ],
        },
      }),
    });

    // The shared deployment-version tracker lives in the PROD account. The
    // resource policy allow-list covers the prod role, but the sandbox role is
    // a CROSS-ACCOUNT caller and needs an identity policy too. Without this,
    // compute-version silently falls back (0.1.0 -> 0.1.1 on every merge) and
    // record-deployment logs HTTP 403 for sandbox only.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: ['arn:aws:execute-api:eu-west-2:637423226886:*/*/*/deployments/*'],
      }),
    );

    this.roleArn = role.roleArn;

    new cdk.CfnOutput(this, 'GithubCiRoleArn', {
      value: role.roleArn,
      description: `Role ARN for GitHub Actions (${deployEnv})`,
    });
  }
}
