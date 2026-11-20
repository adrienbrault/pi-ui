import * as coding from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { createPiKit } from "../render/pi-kit.ts";

export const KIT = createPiKit(tui, coding);
