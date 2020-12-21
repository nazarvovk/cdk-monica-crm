#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkMonicaCrmStack } from '../lib/cdk-monica-crm-stack';

const app = new cdk.App();
new CdkMonicaCrmStack(app, 'CdkMonicaCrmStack');
