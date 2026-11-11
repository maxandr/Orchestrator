import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import Projects from "./pages/Projects";
import Project from "./pages/Project";
import Feature from "./pages/Feature";
import Layout from "./components/Layout";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<Project />} />
          <Route path="/features/:id" element={<Feature />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
