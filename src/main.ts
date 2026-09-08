import { FengyueLinkApp } from "./app";

if (window.top === window.self && !document.querySelector("#fengyue-link-root")) {
  new FengyueLinkApp();
}
