import { describeProjectStoreContract } from "./projectStoreContract";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";

describeProjectStoreContract("内存实现", async () => createMemoryProjectStore());
