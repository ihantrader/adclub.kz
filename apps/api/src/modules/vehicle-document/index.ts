export { VehicleDocumentModule } from "./vehicle-document.module";
export type { VehicleDocumentModuleOptions } from "./vehicle-document.module";
export { DocumentProofs } from "./document-proofs";
export { DEVICE_WINDOW_SECONDS, DocumentAttempts, RecognitionAttempts } from "./document-attempts";
export type { Bucket, CountedAttempt, DocumentReader } from "./document-attempts";
export { PhotoRecognitions } from "./photo-recognitions";
export type { PhotoReading } from "./photo-recognitions";
export { photoReaderOf } from "./photo-reader";
export { VehicleMatching } from "./vehicle-matching";
export { VehicleDocumentService, documentFields, documentKind } from "./vehicle-document.service";
export { DocumentImageRejected, prepareDocumentImage } from "./document-image";
export {
  DocumentEvalBudgetError,
  saveDocumentEvalRun,
  VehicleDocumentEval,
} from "./eval/document-eval-runner";
