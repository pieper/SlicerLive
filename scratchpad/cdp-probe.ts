import { CDP } from "../harness/cdp.ts";
const cdp = await CDP.attachToPage(9222);
console.log("attached");
const two = await cdp.eval("return 1+1;");
console.log("eval 1+1 =", two);
cdp.close();
