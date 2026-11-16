export { SpeechModule } from "./speech.module";
export { SpeechRecognitions } from "./speech.service";
export { SpeechAttempts } from "./speech-attempts";
export {
  loadSpeechEvalData,
  saveSpeechEvalRun,
  SpeechEval,
  SpeechEvalBudgetError,
  speechEvalDirectory,
} from "./eval/speech-eval-runner";
export type { SpeechEvalRun, SpeechEvalSample } from "./eval/speech-eval-runner";
export { scoreSpeech, wordErrorRate, speechWords } from "./eval/speech-eval-score";
