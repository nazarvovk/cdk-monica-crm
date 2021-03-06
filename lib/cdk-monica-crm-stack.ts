import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as rds from '@aws-cdk/aws-rds';
import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';
import * as secretsmanager from '@aws-cdk/aws-secretsmanager';
require('dotenv').config();

export class CdkMonicaCrmStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucketUser = new iam.User(this, 'MonicaUser');
    const accessKey = new iam.CfnAccessKey(this, 'AccessKey', {
      userName: bucketUser.userName,
    });
    const bucket = new s3.Bucket(this, 'StorageBucket', {});
    bucket.grantReadWrite(bucketUser);

    const vpc = new ec2.Vpc(this, 'VpcInstance', {});

    const monicaDbPassword = new secretsmanager.Secret(
      this,
      'monicaDbPassword',
      {
        generateSecretString: {
          excludeCharacters: '/@" ',
        },
      }
    );

    const auroraCluster = new rds.ServerlessCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.AURORA,
      vpc,
      defaultDatabaseName: 'monica',
      credentials: {
        username: 'admin',
        password: monicaDbPassword.secretValue,
      },
      scaling: {
        minCapacity: 1,
        maxCapacity: 1,
        autoPause: cdk.Duration.minutes(45),
      },
    });
    auroraCluster.connections.allowFromAnyIpv4(ec2.Port.allTcp());

    const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
    });

    ecsCluster.addCapacity('EcsInstance', {
      instanceType: new ec2.InstanceType('t3a.nano'),
      desiredCapacity: 1,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
    });

    ecsCluster.connections.allowFromAnyIpv4(ec2.Port.allTcp());
    const taskDefinition = new ecs.Ec2TaskDefinition(
      this,
      'TaskDefinition',
      {}
    );
    const allowEcsStatement = new iam.PolicyStatement({
      sid: 'TraefikECSReadAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:ListClusters',
        'ecs:DescribeClusters',
        'ecs:ListTasks',
        'ecs:DescribeTasks',
        'ecs:DescribeContainerInstances',
        'ecs:DescribeTaskDefinition',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    });
    taskDefinition.addToTaskRolePolicy(allowEcsStatement);
    taskDefinition.addToExecutionRolePolicy(allowEcsStatement);

    taskDefinition.addVolume({
      name: 'dockersock',
      host: {
        sourcePath: '/var/run/docker.sock',
      },
    });
    taskDefinition.addVolume({
      name: 'tmp',
      host: {
        sourcePath: '/tmp/',
      },
    });

    const monicaContainer = new ecs.ContainerDefinition(
      this,
      'monicaContainer',
      {
        taskDefinition,
        image: ecs.ContainerImage.fromRegistry('monicahq/monicahq'),
        memoryReservationMiB: 250,
        logging: ecs.LogDriver.awsLogs({
          streamPrefix: 'CDK-MonicaContainer',
        }),
        environment: {
          APP_DEBUG: 'true',
          APP_KEY: 'z9d0DCivTAzfwWq3UFralPUrkuoXZlDl',
          APP_TRUSTED_PROXIES: '*',
          AWS_REGION: this.region,
          AWS_BUCKET: bucket.bucketName,
          AWS_KEY: accessKey.ref,
          AWS_SECRET: accessKey.attrSecretAccessKey,
          AWS_SERVER: '',
          DAV_ENABLED: 'true',
          DB_HOST: auroraCluster.clusterEndpoint.hostname,
          DB_USERNAME: 'admin',
          DEFAULT_FILESYSTEM: 's3',
          MAIL_ENCRYPTION: 'tls',
          MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS || '',
          MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || '',
          MAIL_HOST: process.env.MAIL_HOST || '',
          MAIL_PASSWORD: process.env.MAIL_PASSWORD || '',
          MAIL_USERNAME: process.env.MAIL_USERNAME || '',
          MAIL_MAILER: 'smtp',
          MAIL_PORT: '587',
          MFA_ENABLED: 'true',
          APP_DISABLE_SIGNUP: 'false',
        },
        secrets: {
          DB_PASSWORD: ecs.Secret.fromSecretsManager(monicaDbPassword),
        },
        dockerLabels: {
          'traefik.enable': 'true',
          'traefik.http.routers.app.entrypoints': 'app',
          'traefik.http.routers.app.rule': `Host(\`${process.env.DOMAIN_NAME}\`)`,
          'traefik.http.services.app.loadbalancer.server.port': '80',
          'traefik.http.routers.app.tls.certresolver': 'mytls',
          'traefik.http.middlewares.redirect.redirectscheme.scheme': 'https',
          'traefik.http.middlewares.redirect.redirectscheme.permanent': 'true',
        },
      }
    );
    monicaContainer.addPortMappings({
      hostPort: 80,
      protocol: ecs.Protocol.TCP,
      containerPort: 80,
    });

    const traefikContainer = new ecs.ContainerDefinition(
      this,
      'traefikContainer',
      {
        taskDefinition,
        image: ecs.ContainerImage.fromRegistry('traefik:v2.3.0-rc2'),
        memoryReservationMiB: 200,
        logging: ecs.LogDriver.awsLogs({
          streamPrefix: 'CDK-TraefikContainer',
        }),
        environment: {
          TRAEFIK_API_INSECURE: 'true',
          TRAEFIK_API_DASHBOARD: 'true',
          TRAEFIK_API_DEBUG: 'true',
          TRAEFIK_LOG_LEVEL: 'DEBUG',

          TRAEFIK_PROVIDERS_ECS: 'true',
          TRAEFIK_PROVIDERS_ECS_EXPOSEDBYDEFAULT: 'false',
          TRAEFIK_PROVIDERS_ECS_CLUSTERS: ecsCluster.clusterName,
          TRAEFIK_PROVIDERS_ECS_REGION: this.region,
          TRAEFIK_ENTRYPOINTS_APP_ADDRESS: ':443',

          TRAEFIK_CERTIFICATESRESOLVERS_MYTLS_ACME_EMAIL:
            process.env.SSL_EMAIL || '',
          TRAEFIK_CERTIFICATESRESOLVERS_MYTLS_ACME_TLSCHALLENGE: 'true',
          TRAEFIK_CERTIFICATESRSOLVERS_MYTLS_ACME_STORAGE:
            '/letsencrypt/acme.json',
        },
        dockerLabels: {
          'traefik.enable': 'true',
          'traefik.http.routers.api.rule': `Host(\`traefik.${process.env.DOMAIN_NAME}\`)`,
          'traefik.http.routers.api.service': 'api@internal',
        },
      }
    );
    traefikContainer.addLink(monicaContainer);

    traefikContainer.addContainerDependencies({
      container: monicaContainer,
      condition: ecs.ContainerDependencyCondition.START,
    });
    traefikContainer.addMountPoints(
      {
        readOnly: true,
        containerPath: '/var/run/docker.sock',
        sourceVolume: 'dockersock',
      },
      {
        readOnly: false,
        containerPath: '/letsencrypt',
        sourceVolume: 'tmp',
      }
    );
    traefikContainer.addPortMappings(
      {
        hostPort: 443,
        protocol: ecs.Protocol.TCP,
        containerPort: 443,
      },
      {
        hostPort: 8080,
        protocol: ecs.Protocol.TCP,
        containerPort: 8080,
      }
    );

    const service = new ecs.Ec2Service(this, 'MonicaService', {
      cluster: ecsCluster,
      taskDefinition,
    });
  }
}
