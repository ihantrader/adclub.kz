# Speaks a text into a WAV with a voice of Windows (System.Speech, no network)
# for the synthetic speech samples of TASK-059 (`scripts/speech-samples.mjs`).
# 16 kHz, 16-bit, mono — the format the app records.
#
# Usage: powershell -NoProfile -File scripts/speech-tts.ps1 -Voice "<name>" -TextFile <utf-8 file> -Out <wav>
param(
  [Parameter(Mandatory = $true)][string]$Voice,
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Rate = 0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice($Voice)
  $synth.Rate = $Rate
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($Out, $format)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
