import "./style.css";
import { InferenceSource } from "firebase/ai";
import { model } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const nanoStatus = $("nano-status");
const downloadBtn = $("download");
const form = $("prompt-form");
const output = $("output");
const source = $("source");

// Chrome's built-in Prompt API (Gemini Nano). Absent in other browsers or without the flag.
async function checkNano() {
  if (!("LanguageModel" in self)) {
    nanoStatus.textContent = "not supported in this browser (cloud fallback will be used)";
    return;
  }
  const availability = await LanguageModel.availability();
  nanoStatus.textContent =
    availability === "unavailable"
      ? "unavailable on this device (cloud fallback will be used)"
      : availability;
  downloadBtn.hidden = availability !== "downloadable";
}

// The download must start from a user gesture.
downloadBtn.addEventListener("click", () => {
  downloadBtn.disabled = true;
  model.initializeDeviceModel((fraction) => {
    nanoStatus.textContent = `downloading ${Math.round(fraction * 100)}%`;
    if (fraction >= 1) checkNano();
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  output.textContent = "";
  source.textContent = "…";
  try {
    const result = await model.generateContentStream(prompt);
    for await (const chunk of result.stream) output.textContent += chunk.text();
    const response = await result.response;
    source.textContent = response.inferenceSource === InferenceSource.ON_DEVICE ? "Gemini Nano (on-device)" : "Gemini (cloud)";
  } catch (err) {
    source.textContent = "error";
    output.textContent = String(err?.message ?? err);
    console.error(err);
  }
});

checkNano();
