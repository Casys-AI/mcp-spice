import { bootSpiceApp } from "../../shared/surface-app.ts";
import { startSpiceReceiptApp } from "./app.ts";

bootSpiceApp("SPICE receipt viewer unavailable", startSpiceReceiptApp);
