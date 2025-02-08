import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ExcalidrawApp } from "../packages/excalidraw/ExcalidrawApp";
import { registerSW } from "virtual:pwa-register";
import PocketBase from "pocketbase";
import "../excalidraw-app/sentry";
import type { StorageProvider } from "../packages/excalidraw";
import type { FileId } from "../packages/excalidraw/element/types";
window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();

class PocketbaseStorageProvider implements StorageProvider {
  private pb: PocketBase;
  private pbEndpoint: string;
  constructor() {
    this.pbEndpoint = "http://localhost:8090";
    this.pb = new PocketBase(this.pbEndpoint);
  }
  fetchRecord = async (
    roomId: string,
  ): Promise<
    { id: string; ciphertext: ArrayBuffer; iv: Uint8Array } | null | undefined
  > => {
    let record:
      | { id: string; ciphertext: ArrayBuffer; iv: Uint8Array }
      | null
      | undefined;
    try {
      const records = await this.pb
        .collection("scenes")
        .getFullList({ filter: `roomId="${roomId}"` });
      if (records.length > 0) {
        record = {
          id: records[0].id,
          ciphertext: records[0].ciphertext,
          iv: records[0].iv,
        };
      }
    } catch {
      // Record doesn't exist, create new
      record = null;
    }
    return record;
  };
  updateRecord = async (
    id: string,
    data: {
      roomId: string;
      sceneVersion: number;
      ciphertext: number[];
      iv: number[];
    },
  ): Promise<void> => {
    const { roomId, sceneVersion, ciphertext, iv } = data;
    await this.pb.collection("scenes").update(id, {
      roomId,
      sceneVersion,
      ciphertext,
      iv,
      roomKey: null,
    });
  };
  createRecord = async (data: {
    roomId: string;
    sceneVersion: number;
    ciphertext: number[];
    iv: number[];
  }): Promise<void> => {
    const { roomId, sceneVersion, ciphertext, iv } = data;
    await this.pb.collection("scenes").create({
      roomId,
      sceneVersion,
      ciphertext,
      iv,
      roomKey: null,
    });
  };
  saveFile = async (prefix: string, id: FileId, blob: Blob): Promise<void> => {
    const formData = new FormData();
    formData.append("ref", `${prefix}/${id}`);
    formData.append("file", blob, id);

    await this.pb.collection("files").create(formData);
  };
  getFileUrl = async (prefix: string, id: string): Promise<string | null> => {
    const file = await this.pb
      .collection("files")
      .getFullList({ filter: `ref="/${prefix}/${id}"` });
    if (file.length !== 0) {
      return `${this.pbEndpoint}/api/files/files/${file[0].id}/${file[0].file}`;
    }
    return null;
  };
}
const storageProvider = new PocketbaseStorageProvider();
root.render(
  <StrictMode>
    <ExcalidrawApp
      excalidraw={{
        aiEnabled: false,
        UIOptions: {
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
          },
        },
      }}
      collabServerUrl="http://localhost:3002"
      storageProvider={storageProvider}
    />
  </StrictMode>,
);
