import { IS_BROWSER } from "$fresh/runtime.ts";
import { createContext } from "preact";
import { computed, signal } from "@preact/signals";
import * as monaco from "monaco-editor";

function createEditorState() {
  const currentTab = signal(0);
  const darkMode = signal(false);
  const dirty = signal(false);
  const docModel = signal<monaco.editor.ITextModel | null>(null);
  const editor = signal<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fixes = signal<string[]>([]);
  const fixModels = signal<monaco.editor.ITextModel[] | null>(null);
  const md = signal("");

  const fixCount = computed(() => fixes.value.length);

  if (IS_BROWSER && "matchMedia" in window) {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      darkMode.value = true;
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener(
      "change",
      (evt) => {
        if (evt.matches) {
          darkMode.value = true;
        } else {
          darkMode.value = false;
        }
      },
    );
  }

  return {
    currentTab,
    darkMode,
    dirty,
    docModel,
    editor,
    fixCount,
    fixes,
    fixModels,
    md,
  };
}

export const EditorState = createContext(createEditorState());
