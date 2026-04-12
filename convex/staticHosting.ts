import {
  exposeDeploymentQuery,
  exposeUploadApi,
} from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const selfHosting = (components as { selfHosting: Parameters<typeof exposeUploadApi>[0] })
  .selfHosting;

export const {
  gcOldAssets,
  generateUploadUrl,
  generateUploadUrls,
  listAssets,
  recordAsset,
  recordAssets,
} = exposeUploadApi(selfHosting);

export const { getCurrentDeployment } = exposeDeploymentQuery(selfHosting);
