/**
 * The page's entry: `/stage` is the presenter's opening list, every other path is Acme Books.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@stigmer/react-sdk/styles.css";
import "./acme.css";
import { AcmeBooks } from "./AcmeBooks.js";
import { Stage } from "./Stage.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root.");

createRoot(root).render(<StrictMode>{window.location.pathname === "/stage" ? <Stage /> : <AcmeBooks />}</StrictMode>);
