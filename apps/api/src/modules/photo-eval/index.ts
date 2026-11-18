/**
 * The model comparison for the photos of TASK-058 (D-058): a development
 * tool of the operator command (`ai:eval:dashboard`, `ai:eval:part-photo`),
 * not a module of the API or the worker.
 */
export { PhotoEval, PhotoEvalBudgetError, savePhotoEvalRun } from "./photo-eval-runner";
export type { PhotoEvalRun } from "./photo-eval-runner";
export { loadDashboardEvalData, loadPartEvalData, photoEvalDirectory } from "./photo-eval-data";
export type { DashboardEvalSample, PartEvalSample, PhotoEvalKind } from "./photo-eval-data";
export { scoreDashboards, scoreParts } from "./photo-eval-score";
export { scorePricePhotos, PRICE_PHOTO_THRESHOLD } from "./price-photo-score";
export { loadPricePhotoEvalData } from "./photo-eval-data";
export type { PricePhotoEvalSample } from "./photo-eval-data";
