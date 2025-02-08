import { reconcileElements } from "..";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "../element/types";
import { getSceneVersion } from "../element";
import type Portal from "../collab/Portal";
import { restoreElements } from "../data/restore";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../types";
import { decompressData } from "../data/encode";
import { encryptData, decryptData } from "../data/encryption";
import { MIME_TYPES } from "../constants";
import type { SyncableExcalidrawElement } from ".";
import { getSyncableElements } from ".";
import type { Socket } from "socket.io-client";
import type { RemoteExcalidrawElement } from "../data/reconcile";

interface StorageClass {
  isSavedToStorage: (
    portal: Portal,
    elements: readonly ExcalidrawElement[],
  ) => boolean;
  saveFilesToStorage: ({
    prefix,
    files,
  }: {
    prefix: string;
    files: { id: FileId; buffer: Uint8Array }[];
  }) => Promise<{ savedFiles: FileId[]; erroredFiles: FileId[] }>;
  saveToStorage: (
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ) => Promise<readonly SyncableExcalidrawElement[] | null>;
  loadFromStorage: (
    roomId: string,
    roomKey: string,
    socket: Socket | null,
  ) => Promise<readonly SyncableExcalidrawElement[] | null>;
  loadFilesFromStorage: (
    prefix: string,
    decryptionKey: string,
    fileIds: readonly FileId[],
  ) => Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }>;
}
export interface StorageProvider {
  fetchRecord: (
    roomId: string,
  ) => Promise<
    { id: string; ciphertext: ArrayBuffer; iv: Uint8Array } | null | undefined
  >;
  updateRecord: (
    id: string,
    data: {
      roomId: string;
      sceneVersion: number;
      ciphertext: number[];
      iv: number[];
    },
  ) => Promise<void>;
  createRecord: (data: {
    roomId: string;
    sceneVersion: number;
    ciphertext: number[];
    iv: number[];
  }) => Promise<void>;
  saveFile: (prefix: string, id: FileId, blob: Blob) => Promise<void>;
  getFileUrl: (prefix: string, id: string) => Promise<string | null>;
}
// -----------------------------------------------------------------------------
export class Storage implements StorageClass {
  private storageProvider: StorageProvider;
  constructor(storageProvider: StorageProvider) {
    this.storageProvider = storageProvider;
  }
  isSavedToStorage = (
    portal: Portal,
    elements: readonly ExcalidrawElement[],
  ): boolean => {
    if (portal.socket && portal.roomId && portal.roomKey) {
      const sceneVersion = getSceneVersion(elements);

      return StorageSceneVersionCache.get(portal.socket) === sceneVersion;
    }
    // if no room exists, consider the room saved so that we don't unnecessarily
    // prevent unload (there's nothing we could do at that point anyway)
    return true;
  };
  saveFilesToStorage = async ({
    prefix,
    files,
  }: {
    prefix: string;
    files: { id: FileId; buffer: Uint8Array }[];
  }) => {
    const erroredFiles: FileId[] = [];
    const savedFiles: FileId[] = [];

    await Promise.all(
      files.map(async ({ id, buffer }) => {
        try {
          await this.storageProvider.saveFile(
            prefix,
            id,
            new Blob([buffer], {
              type: MIME_TYPES.binary,
            }),
          );
          savedFiles.push(id);
        } catch (error) {
          erroredFiles.push(id);
        }
      }),
    );

    return { savedFiles, erroredFiles };
  };
  saveToStorage = async (
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ) => {
    const { roomId, roomKey, socket } = portal;
    if (
      !roomId ||
      !roomKey ||
      !socket ||
      this.isSavedToStorage(portal, elements)
    ) {
      return null;
    }

    try {
      // Check if record exists
      const record = await this.storageProvider.fetchRecord(roomId);

      const { ciphertext, iv } = await this.encryptElements(roomKey, elements);
      const sceneVersion = getSceneVersion(elements);
      if (record) {
        const data: StorageStoredScene = {
          ciphertext: new Uint8Array(record.ciphertext).buffer,
          iv: new Uint8Array(record.iv),
        };
        // Reconcile existing elements
        const prevStoredElements = getSyncableElements(
          restoreElements(await this.decryptElements(data, roomKey), null),
        );

        const reconciledElements = getSyncableElements(
          reconcileElements(
            elements,
            prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        );
        // Update existing record
        await this.storageProvider.updateRecord(record.id, {
          roomId,
          sceneVersion,
          ciphertext: Array.from(new Uint8Array(ciphertext)),
          iv: Array.from(iv),
        });

        return reconciledElements;
      }
      // Create new record
      await this.storageProvider.createRecord({
        roomId,
        sceneVersion,
        ciphertext: Array.from(new Uint8Array(ciphertext)),
        iv: Array.from(iv),
      });

      return elements;
    } catch (error) {
      console.error("Storage save error:", error);
      return null;
    }
  };
  loadFromStorage = async (
    roomId: string,
    roomKey: string,
    socket: Socket | null,
  ): Promise<readonly SyncableExcalidrawElement[] | null> => {
    try {
      const record = await this.storageProvider.fetchRecord(roomId);
      if (!record) {
        return null;
      }
      const data: StorageStoredScene = {
        ciphertext: new Uint8Array(record.ciphertext).buffer,
        iv: new Uint8Array(record.iv),
      };

      const elements = getSyncableElements(
        restoreElements(await this.decryptElements(data, roomKey), null),
      );

      if (socket) {
        StorageSceneVersionCache.set(socket, elements);
      }

      return elements;
    } catch {
      return null;
    }
  };
  loadFilesFromStorage = async (
    prefix: string,
    decryptionKey: string,
    fileIds: readonly FileId[],
  ) => {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();

    await Promise.all(
      [...new Set(fileIds)].map(async (id) => {
        try {
          const fileUrl = await this.storageProvider.getFileUrl(prefix, id);
          if (fileUrl) {
            const response = await fetch(fileUrl);

            if (response.status < 400) {
              const arrayBuffer = await response.arrayBuffer();

              const { data, metadata } =
                await decompressData<BinaryFileMetadata>(
                  new Uint8Array(arrayBuffer),
                  { decryptionKey },
                );

              const dataURL = new TextDecoder().decode(data) as DataURL;

              loadedFiles.push({
                mimeType: metadata.mimeType || MIME_TYPES.binary,
                id,
                dataURL,
                created: metadata?.created || Date.now(),
                lastRetrieved: metadata?.created || Date.now(),
              });
            } else {
              erroredFiles.set(id, true);
            }
          } else {
            erroredFiles.set(id, true);
          }
        } catch (error) {
          erroredFiles.set(id, true);
          console.error(error);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  };
  private encryptElements = async (
    key: string,
    elements: readonly ExcalidrawElement[],
  ): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
    const json = JSON.stringify(elements);
    const encoded = new TextEncoder().encode(json);
    const { encryptedBuffer, iv } = await encryptData(key, encoded);

    return { ciphertext: encryptedBuffer, iv };
  };
  private decryptElements = async (
    data: StorageStoredScene,
    roomKey: string,
  ): Promise<readonly ExcalidrawElement[]> => {
    const ciphertext = data.ciphertext;
    const iv = data.iv;

    const decrypted = await decryptData(iv, ciphertext, roomKey);
    const decodedData = new TextDecoder("utf-8").decode(
      new Uint8Array(decrypted),
    );
    return JSON.parse(decodedData);
  };
  // fetchRecord = async (roomId: string): Promise<RecordModel | null | undefined> => {
  //   let record;
  //   try {
  //     const records = await this.pb
  //       .collection("scenes")
  //       .getFullList({ filter: `roomId="${roomId}"` });
  //     if (records.length > 0) {
  //       record = records[0];
  //     }
  //   } catch {
  //     // Record doesn't exist, create new
  //     record = null;
  //   }
  //   return record
  // }
  // updateRecord = async (id: string, data: { roomId: string, sceneVersion: number, ciphertext: number[], iv: number[] }): Promise<void> => {
  //   const { roomId, sceneVersion, ciphertext, iv } = data;
  //   await this.pb.collection("scenes").update(id, {
  //     roomId,
  //     sceneVersion,
  //     ciphertext,
  //     iv,
  //     roomKey: null,
  //   });
  // }
  // createRecord = async (data: { roomId: string, sceneVersion: number, ciphertext: number[], iv: number[] }): Promise<void> => {
  //   const { roomId, sceneVersion, ciphertext, iv } = data;
  //   await this.pb.collection("scenes").create({
  //     roomId,
  //     sceneVersion,
  //     ciphertext,
  //     iv,
  //     roomKey: null,
  //   });
  // }
  // saveFile = async (prefix: string, id: FileId, blob: Blob): Promise<void> => {
  //   const formData = new FormData();
  //   formData.append("ref", `${prefix}/${id}`);
  //   formData.append(
  //     "file",
  //     blob,
  //     id,
  //   );

  //   await this.pb.collection("files").create(formData);
  // }
  // getFileUrl = async (prefix: string, id: string): Promise<string | null> => {
  //   const file = await this.pb
  //     .collection("files")
  //     .getFullList({ filter: `ref="/${prefix}/${id}"` });
  //   if (file.length != 0) {
  //     return `${this.pbEndpoint}/api/files/files/${file[0].id}/${file[0].file}`;
  //   } else {
  //     return null;
  //   }
  // }
}

interface StorageStoredScene {
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

class StorageSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return StorageSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    StorageSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}
// -----------------------------------------------------------------------------
