import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const bootstrap = readRepositoryFile("infra/aws/github-actions-bootstrap.yaml");
const application = readRepositoryFile("infra/aws/quickducks.yaml");
const release = readRepositoryFile(".github/workflows/release.yml");

const section = (text, start, end) => {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
};

test("AWS bootstrap uses exact GitHub environment trust and fixed role outputs", () => {
  assert.match(bootstrap, /Default: jameskorzekwa@38769771\/duck-race-manager@1312323923/);
  assert.match(bootstrap, /Default: production/);
  assert.match(bootstrap, /Default: quickducks-production/);
  assert.match(bootstrap, /Default: us-east-1_QuEKwmLhI/);
  assert.match(bootstrap, /Url: https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(bootstrap, /ClientIdList:\n\s+- sts\.amazonaws\.com/);
  assert.doesNotMatch(bootstrap, /ThumbprintList/);

  const deploymentRole = section(bootstrap, "  GitHubDeploymentRole:", "Outputs:");
  assert.match(deploymentRole, /RoleName: quickducks-github-deploy/);
  assert.match(deploymentRole, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/);
  assert.match(
    deploymentRole,
    /token\.actions\.githubusercontent\.com:sub: !Sub repo:\$\{GitHubRepositorySubject\}:environment:\$\{GitHubEnvironment\}/,
  );
  assert.doesNotMatch(
    deploymentRole.match(/token\.actions\.githubusercontent\.com:sub:.*$/m)?.[0] ?? "",
    /\*/,
  );

  const executionRole = section(bootstrap, "  CloudFormationExecutionRole:", "  GitHubDeploymentRole:");
  assert.match(executionRole, /RoleName: quickducks-cloudformation-execution/);
  assert.match(executionRole, /Service: cloudformation\.amazonaws\.com/);
  assert.doesNotMatch(executionRole, /AssumeRoleWithWebIdentity/);
  assert.match(bootstrap, /GitHubDeploymentRoleArn:[\s\S]*!GetAtt GitHubDeploymentRole\.Arn/);
  assert.match(bootstrap, /CloudFormationExecutionRoleArn:[\s\S]*!GetAtt CloudFormationExecutionRole\.Arn/);
});

test("CloudFormation execution role is limited to application resource types and identities", () => {
  const resourceTypes = [...application.matchAll(/^\s+Type: (AWS::\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(resourceTypes, [
    "AWS::Cognito::UserPool",
    "AWS::Cognito::UserPoolClient",
    "AWS::Cognito::UserPoolDomain",
    "AWS::Cognito::ManagedLoginBranding",
    "AWS::SES::EmailIdentity",
    "AWS::IAM::User",
  ]);

  const executionRole = section(bootstrap, "  CloudFormationExecutionRole:", "  GitHubDeploymentRole:");
  const wildcardStatements = executionRole
    .split(/^\s+- Sid: /m)
    .slice(1)
    .filter((statement) => /Resource: "\*"/.test(statement))
    .map((statement) => statement.slice(0, statement.indexOf("\n")));
  assert.deepEqual(wildcardStatements, ["CreateTaggedUserPool", "DescribeUserPoolDomainByName"]);

  assert.match(executionRole, /aws:RequestTag\/Project: quickducks/);
  assert.match(executionRole, /aws:RequestTag\/Environment: production/);
  assert.match(executionRole, /aws:ResourceTag\/Project: quickducks/);
  assert.match(executionRole, /aws:ResourceTag\/Environment: production/);
  assert.match(executionRole, /identity\/quickducks\.com/);
  assert.match(executionRole, /user\/quickducks-worker-ses/);
  assert.match(application, /UserName: quickducks-worker-ses[\s\S]*Key: Environment\n\s+Value: production/);
  assert.match(
    application,
    /PermissionsBoundary: !Sub arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:policy\/quickducks-worker-ses-boundary/,
  );

  const boundary = section(bootstrap, "  WorkerPermissionsBoundary:", "  GitHubActionsOidcProvider:");
  assert.match(boundary, /ManagedPolicyName: quickducks-worker-ses-boundary/);
  assert.match(boundary, /- ses:SendEmail\n\s+- ses:SendRawEmail/);
  assert.match(boundary, /- sms-voice:DescribeOptedOutNumbers\n\s+- sms-voice:SendTextMessage/);
  assert.match(boundary, /aws:RequestedRegion: us-east-1/);
  assert.match(boundary, /identity\/quickducks\.com/);
  assert.match(boundary, /userpool\/\$\{StaffUserPoolId\}/);
  assert.doesNotMatch(boundary, /userpool\/\*/);
  assert.doesNotMatch(boundary, /ses:\*/);
  assert.doesNotMatch(boundary, /sms-voice:\*/);
  assert.match(application, /- sms-voice:DescribeOptedOutNumbers\n\s+- sms-voice:SendTextMessage/);
  assert.match(application, /aws:RequestedRegion: us-east-1/);
  assert.match(executionRole, /Action: iam:PutUserPermissionsBoundary/);
  assert.doesNotMatch(executionRole, /iam:DeleteUserPermissionsBoundary/);
  assert.match(executionRole, /iam:PermissionsBoundary: !Ref WorkerPermissionsBoundary/);

  for (const forbidden of [
    "AdministratorAccess",
    "iam:*",
    "iam:AttachUserPolicy",
    "iam:CreateAccessKey",
    "iam:CreatePolicy",
    "iam:CreateRole",
    "iam:DeleteAccessKey",
    "iam:DeleteRole",
    "iam:PutRolePolicy",
    "iam:UpdateAccessKey",
    "ses:*",
  ]) {
    assert.equal(executionRole.includes(forbidden), false, `Execution role must not contain ${forbidden}`);
  }
});

test("GitHub deployment role controls only the application stack and execution role", () => {
  const deploymentRole = section(bootstrap, "  GitHubDeploymentRole:", "Outputs:");
  const actions = [...deploymentRole.matchAll(/^\s+(?:Action: |- )((?:cloudformation|iam):\S+)$/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(actions, [
    "cloudformation:CreateChangeSet",
    "cloudformation:DeleteChangeSet",
    "cloudformation:DescribeChangeSet",
    "cloudformation:DescribeStacks",
    "cloudformation:ExecuteChangeSet",
    "cloudformation:GetTemplateSummary",
    "cloudformation:ValidateTemplate",
    "iam:PassRole",
  ].sort());
  assert.match(deploymentRole, /Action: cloudformation:ValidateTemplate\n\s+Resource: "\*"/);
  assert.doesNotMatch(deploymentRole, /cloudformation:(?:TagResource|UntagResource)/);
  assert.match(deploymentRole, /stack\/\$\{ApplicationStackName\}\/\*/);
  assert.match(deploymentRole, /cloudformation:ChangeSetName: awscli-cloudformation-package-deploy-\*/);
  assert.match(
    deploymentRole,
    /Sid: ManageApplicationChangeSet[\s\S]*aws:ResourceTag\/Project: quickducks[\s\S]*aws:ResourceTag\/Environment: production/,
  );
  assert.match(deploymentRole, /Action: iam:PassRole\n\s+Resource: !GetAtt CloudFormationExecutionRole\.Arn/);
  assert.match(deploymentRole, /iam:PassedToService: cloudformation\.amazonaws\.com/);
  assert.doesNotMatch(deploymentRole, /cognito-idp:|ses:/);
  assert.doesNotMatch(deploymentRole, /cloudformation:(?:DescribeStackEvents|ListChangeSets|ListStacks)/);
});

test("release requires the bootstrap execution role without weakening deployment gates", () => {
  assert.match(release, /AWS_CLOUDFORMATION_ROLE_ARN: \$\{\{ vars\.AWS_CLOUDFORMATION_ROLE_ARN \}\}/);
  assert.match(release, /AWS_CLOUDFORMATION_ROLE_ARN\n\s+AWS_DEPLOY_ROLE_ARN/);
  assert.match(release, /arn:aws:iam::\$\{expectedAccountId\}:role\/quickducks-cloudformation-execution/);
  assert.match(release, /infra\/aws\/github-actions-bootstrap\.yaml infra\/aws\/quickducks\.yaml/);
  assert.match(release, /assertReleaseCommitAncestry/);
  assert.match(release, /NOT EXISTS \(SELECT 1 FROM staff_role_assignments/);
  assert.equal(release.match(/fetch-depth: 0/g)?.length, 2, "Both release jobs must fetch full Git history");
  assert.equal(release.match(/fetch-tags: true/g)?.length, 2, "Both release jobs must fetch every release tag");
  assert.equal(release.match(/persist-credentials: false/g)?.length, 2, "Release checkouts must not persist credentials");

  const lines = release.split("\n");
  const deployCommands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("aws cloudformation deploy \\")) continue;
    const command = [lines[index]];
    while (command.at(-1).trimEnd().endsWith("\\")) {
      index += 1;
      command.push(lines[index]);
    }
    deployCommands.push(command.join("\n"));
  }
  assert.ok(deployCommands.length > 0, "Release must deploy the application stack");
  for (const command of deployCommands) {
    assert.match(command, /--role-arn "\$AWS_CLOUDFORMATION_ROLE_ARN"/);
  }

  for (const preservedGate of [
    "id-token: write",
    "Verify D1 role migration safety",
    "assessReleaseVersion",
    "Required CloudFormation stack",
    "Apply production D1 migrations",
    "Deploy Cloudflare Worker",
    "Smoke-test apex and www redirect",
    "Publish GitHub release",
  ]) {
    assert.ok(release.includes(preservedGate), `Release must preserve ${preservedGate}`);
  }
});
