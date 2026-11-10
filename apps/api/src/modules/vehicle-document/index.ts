export { VehicleDocumentModule } from "./vehicle-document.module";
export type { VehicleDocumentModuleOptions } from "./vehicle-document.module";
export { DocumentProofs } from "./document-proofs";
export { DocumentAttempts } from "./document-attempts";
export type { DocumentReader } from "./document-attempts";
export { PhotoRecognitions } from "./photo-recognitions";
export type { PhotoReading } from "./photo-recognitions";
export { photoReaderOf } from "./photo-reader";
export { VehicleDocumentService, documentFields, documentKind } from "./vehicle-document.service";
export { DocumentImageRejected, prepareDocumentImage } from "./document-image";
export {
  DocumentEvalBudgetError,
  saveDocumentEvalRun,
  VehicleDocumentEval,
} from "./eval/document-eval-runner";
