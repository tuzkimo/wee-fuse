import "fake-indexeddb/auto";
import { describeProjectStoreContract } from "./projectStoreContract";
import { createIdbProjectStore } from "@/services/idbProjectStore";

let counter = 0;
describeProjectStoreContract("IndexedDB 实现", async () => {
  counter += 1;
  return createIdbProjectStore({ databaseName: `wee-fuse-contract-${counter}` });
});
