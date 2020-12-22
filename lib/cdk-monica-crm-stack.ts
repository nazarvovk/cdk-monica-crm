import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as rds from '@aws-cdk/aws-rds';
import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import * as secretsmanager from '@aws-cdk/aws-secretsmanager';

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
        /* bug in cdk, according to the docs, this should work
        https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-rds.ServerlessScalingOptions.html */
        // @ts-ignore
        autoPause: cdk.Duration.minutes(45),
      },
    });

    const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
    });
    ecsCluster.addCapacity('EcsInstance', {
      instanceType: new ec2.InstanceType('t3a.nano'),
      desiredCapacity: 1,
    });
    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition');
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
    // Monica container
    const monicaContainer = new ecs.ContainerDefinition(
      this,
      'monicaContainer',
      {
        taskDefinition,
        image: ecs.ContainerImage.fromRegistry('monicahq/monica'),
        memoryReservationMiB: 250,
        environment: {
          APP_KEY: 'z9d0DCivTAzfwWq3UFralPUrkuoXZlDl',
          APP_TRUSTED_PROXIES: '*',
          AWS_REGION: 'eu-central-1',
          AWS_BUCKET: bucket.bucketName,
          // FIXME move AWS_KEY & AWS_SECRET to secrets
          // AWS_KEY: '<<AWS KEY TO ACCESS BUCKET>>',
          AWS_KEY: accessKey.ref,
          // AWS_SECRET: '<<AWS SECRET TO ACCESS BUCKET>>',
          AWS_SECRET: accessKey.attrSecretAccessKey,
          AWS_SERVER: '',
          DAV_ENABLED: 'true',
          DB_HOST: auroraCluster.clusterIdentifier,
          DB_USERNAME: 'admin',
          DEFAULT_FILESYSTEM: 's3',
          MAIL_ENCRYPTION: 'tls',
          // MAIL_FROM_ADDRESS: '<<FROM EMAIL ADDRESS>>',
          // MAIL_FROM_NAME: '<<FROM EMAIL NAME>>',
          // MAIL_HOST: '<<SMTP HOST>>',
          // MAIL_PASSWORD: '<<SMTP PASSWORD>>',
          // MAIL_USERNAME: '<<SMTP USERNAME>>',
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
          'traefik.http.routers.app.rule': `Host(\`${this.stackName}\`)`,
          'traefik.http.routers.app.tls.certresolver': 'mytls',
        },
      }
    );

    const traefikContainer = new ecs.ContainerDefinition(
      this,
      'traeficContainer',
      {
        taskDefinition,
        image: ecs.ContainerImage.fromRegistry('traefik:v2.3.0-rc2'),
        memoryReservationMiB: 200,
        environment: {
          TRAEFIK_API_INSECURE: 'true',
          TRAEFIK_CERTIFICATESRESOLVERS_MYTLS_ACME_EMAIL: 'work@nvovk.com',
          TRAEFIK_CERTIFICATESRESOLVERS_MYTLS_ACME_TLSCHALLENGE: 'true',
          TRAEFIK_CERTIFICATESRSOLVERS_MYTLS_ACME_STORAGE:
            '/letsencrypt/acme.json',
          TRAEFIK_ENTRYPOINTS_APP_ADDRESS: ':443',
          TRAEFIK_PROVIDERS_DOCKER: 'true',
          TRAEFIK_PROVIDERS_DOCKER_EXPOSEDBYDEFAULT: 'false',
        },
      }
    );
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
  }
}
