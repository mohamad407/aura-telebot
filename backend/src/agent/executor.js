"use strict";

const fs = require("fs");
const path = require("path");

// ============================================================
// PROJECT ROOT
// ============================================================

const PROJECTS_DIR = path.resolve(
  __dirname,
  "../projects"
);

// ============================================================
// VALIDATE PROJECT NAME
// ============================================================

function validateProjectName(name) {
  return (
    typeof name === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(name)
  );
}

// ============================================================
// SAFE PROJECT PATH
// ============================================================

function safeProjectPath(projectName, filePath = "") {
  if (!validateProjectName(projectName)) {
    throw new Error(
      `Invalid project name: ${projectName}`
    );
  }

  const projectRoot = path.resolve(
    PROJECTS_DIR,
    projectName
  );

  const targetPath = path.resolve(
    projectRoot,
    filePath
  );

  if (
    targetPath !== projectRoot &&
    !targetPath.startsWith(projectRoot + path.sep)
  ) {
    throw new Error(
      `Unsafe file path detected: ${filePath}`
    );
  }

  return targetPath;
}

// ============================================================
// VALIDATE FILE PATH
// ============================================================

function validateFilePath(filePath) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim()
  ) {
    throw new Error("Invalid file path.");
  }

  const normalized = filePath.replace(/\\/g, "/");

  if (
    path.isAbsolute(filePath) ||
    normalized.startsWith("/")
  ) {
    throw new Error(
      `Absolute file paths are not allowed: ${filePath}`
    );
  }

  const parts = normalized.split("/");

  if (parts.includes("..")) {
    throw new Error(
      `Path traversal is not allowed: ${filePath}`
    );
  }

  return true;
}

// ============================================================
// PROTECTED ENVIRONMENT FILES
// ============================================================

function isProtectedEnvFile(filePath) {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const filename = path.posix.basename(normalized);

  return (
    filename === ".env" ||
    filename.startsWith(".env.")
  );
}

// ============================================================
// DISALLOWED GENERATED FILES
// ============================================================

function isDisallowedGeneratedFile(filePath) {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const filename = path.posix.basename(normalized);

  // Never allow secrets/environment files
  if (isProtectedEnvFile(normalized)) {
    return true;
  }

  // Common secret files
  if (
    filename === "credentials.json" ||
    filename === "service-account.json" ||
    filename === "firebase-adminsdk.json"
  ) {
    return true;
  }

  return false;
}

// ============================================================
// NORMALIZE FRONTEND PATH
// ============================================================
//
// IMPORTANT:
//
// Planner:
// frontend/package.json
//
// Actual:
// project/frontend/package.json
//
// Planner:
// frontend/src/App.jsx
//
// Actual:
// project/frontend/src/App.jsx
//
// This function guarantees that frontend files stay
// inside the frontend directory.
//
// ============================================================

function normalizeFrontendPath(filePath) {
  validateFilePath(filePath);

  let normalized = filePath.replace(/\\/g, "/");

  // Remove accidental leading ./ 
  normalized = normalized.replace(/^\.\/+/, "");

  // Remove duplicate frontend/frontend
  if (normalized.startsWith("frontend/frontend/")) {
    normalized = normalized.replace(
      /^frontend\/frontend\//,
      "frontend/"
    );
  }

  // If planner already uses frontend/, keep it.
  if (normalized === "frontend") {
    return "frontend";
  }

  if (normalized.startsWith("frontend/")) {
    return normalized;
  }

  // Frontend-only Phase 1:
  // every generated frontend file goes inside frontend/
  return `frontend/${normalized}`;
}

// ============================================================
// CREATE PROJECT
// ============================================================

function createProject(name) {
  if (!validateProjectName(name)) {
    throw new Error(
      `Invalid project name: ${name}`
    );
  }

  const projectPath =
    safeProjectPath(name);

  fs.mkdirSync(projectPath, {
    recursive: true,
  });

  console.log(
    `📁 Project ready: ${projectPath}`
  );

  return {
    projectName: name,
    projectPath,
  };
}

// ============================================================
// CHECK PROJECT
// ============================================================

function projectExists(name) {
  if (!validateProjectName(name)) {
    return false;
  }

  const projectPath =
    safeProjectPath(name);

  if (!fs.existsSync(projectPath)) {
    return false;
  }

  return fs.statSync(projectPath).isDirectory();
}

// ============================================================
// CREATE FILE
// ============================================================

function createFile(
  projectName,
  filePath,
  content
) {
  validateFilePath(filePath);

  if (typeof content !== "string") {
    throw new Error(
      `Invalid file content: ${filePath}`
    );
  }

  if (isDisallowedGeneratedFile(filePath)) {
    throw new Error(
      `Environment or secret files are not allowed: ${filePath}`
    );
  }

  const targetPath =
    safeProjectPath(
      projectName,
      filePath
    );

  fs.mkdirSync(
    path.dirname(targetPath),
    {
      recursive: true,
    }
  );

  fs.writeFileSync(
    targetPath,
    content,
    "utf8"
  );

  console.log(
    `📄 Created: ${filePath}`
  );

  return {
    success: true,
    action: "create_file",
    path: filePath,
  };
}

// ============================================================
// UPDATE FILE
// ============================================================

function updateFile(
  projectName,
  filePath,
  content
) {
  validateFilePath(filePath);

  if (typeof content !== "string") {
    throw new Error(
      `Invalid file content: ${filePath}`
    );
  }

  if (isDisallowedGeneratedFile(filePath)) {
    throw new Error(
      `Environment or secret files are not allowed: ${filePath}`
    );
  }

  const targetPath =
    safeProjectPath(
      projectName,
      filePath
    );

  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `File does not exist: ${filePath}`
    );
  }

  if (!fs.statSync(targetPath).isFile()) {
    throw new Error(
      `Target is not a file: ${filePath}`
    );
  }

  fs.writeFileSync(
    targetPath,
    content,
    "utf8"
  );

  console.log(
    `✏️ Updated: ${filePath}`
  );

  return {
    success: true,
    action: "update_file",
    path: filePath,
  };
}

// ============================================================
// SAVE GENERATED FILE
// ============================================================
//
// This is the important function for the new planner.
//
// It automatically ensures frontend files are created under:
//
// project/frontend/
//
// ============================================================

function saveGeneratedFile(
  projectName,
  filePath,
  content
) {
  if (!projectName) {
    throw new Error(
      "Project name is required."
    );
  }

  if (typeof filePath !== "string") {
    throw new Error(
      "Generated file path must be a string."
    );
  }

  if (typeof content !== "string") {
    throw new Error(
      `Generated content must be a string: ${filePath}`
    );
  }

  // Normalize all frontend paths.
  const normalizedPath =
    normalizeFrontendPath(filePath);

  if (
    isDisallowedGeneratedFile(
      normalizedPath
    )
  ) {
    throw new Error(
      `Environment or secret files are not allowed: ${normalizedPath}`
    );
  }

  if (!projectExists(projectName)) {
    createProject(projectName);
  }

  const targetPath =
    safeProjectPath(
      projectName,
      normalizedPath
    );

  fs.mkdirSync(
    path.dirname(targetPath),
    {
      recursive: true,
    }
  );

  fs.writeFileSync(
    targetPath,
    content,
    "utf8"
  );

  console.log(
    `💾 Saved generated file: ${normalizedPath}`
  );

  return {
    success: true,
    projectName,
    path: normalizedPath,
    absolutePath: targetPath,
  };
}

// ============================================================
// EXECUTE DEVELOPMENT PLAN
// ============================================================
//
// Phase 1:
//
// Planner creates actions:
//
// frontend/package.json
// frontend/index.html
// frontend/src/main.jsx
// frontend/src/App.jsx
//
// executePlan() ONLY validates and records those actions.
//
// Actual contents are generated separately.
//
// ============================================================

async function executePlan(plan) {
  if (
    !plan ||
    !Array.isArray(plan.actions)
  ) {
    throw new Error(
      "Invalid Aura plan."
    );
  }

  let projectName = null;

  const results = [];

  // ----------------------------------------------------------
  // PROJECT NAME
  // ----------------------------------------------------------

  if (
    typeof plan.projectName === "string" &&
    plan.projectName.trim()
  ) {
    projectName =
      plan.projectName.trim();

    console.log(
      `📦 Project name from plan: ${projectName}`
    );
  }

  // ----------------------------------------------------------
  // CREATE PROJECT ACTION
  // ----------------------------------------------------------

  const createProjectAction =
    plan.actions.find(
      (action) =>
        action &&
        action.type === "create_project"
    );

  if (
    createProjectAction &&
    typeof createProjectAction.name === "string"
  ) {
    projectName =
      createProjectAction.name.trim();

    console.log(
      `📦 Project name from create_project action: ${projectName}`
    );
  }

  // ----------------------------------------------------------
  // VALIDATE PROJECT
  // ----------------------------------------------------------

  if (!projectName) {
    throw new Error(
      "Project name is missing from Aura plan."
    );
  }

  if (!validateProjectName(projectName)) {
    throw new Error(
      `Invalid project name: ${projectName}`
    );
  }

  // ----------------------------------------------------------
  // CREATE PROJECT
  // ----------------------------------------------------------

  console.log(
    `\n📁 Preparing project directory...`
  );

  const projectInfo =
    createProject(projectName);

  results.push({
    action: "create_project",
    projectName,
    projectPath:
      projectInfo.projectPath,
  });

  // ----------------------------------------------------------
  // PROCESS ACTIONS
  // ----------------------------------------------------------

  console.log(
    `\n⚙️ Processing plan actions...`
  );

  for (
    const action of plan.actions
  ) {
    if (!action) {
      continue;
    }

    // --------------------------------------------------------
    // CREATE PROJECT
    // --------------------------------------------------------

    if (
      action.type === "create_project"
    ) {
      continue;
    }

    // --------------------------------------------------------
    // CREATE FILE
    // --------------------------------------------------------

    if (
      action.type === "create_file"
    ) {
      if (
        typeof action.path !== "string"
      ) {
        throw new Error(
          "create_file requires path."
        );
      }

      const normalizedPath =
        normalizeFrontendPath(
          action.path
        );

      if (
        isDisallowedGeneratedFile(
          normalizedPath
        )
      ) {
        throw new Error(
          `Environment or secret files are not allowed: ${action.path}`
        );
      }

      results.push({
        action: "create_file",
        path: normalizedPath,
        purpose:
          action.purpose || "",
        status: "planned",
      });

      console.log(
        `📋 Planned file: ${normalizedPath}`
      );

      continue;
    }

    // --------------------------------------------------------
    // UPDATE FILE
    // --------------------------------------------------------

    if (
      action.type === "update_file"
    ) {
      if (
        typeof action.content !== "string"
      ) {
        throw new Error(
          `update_file requires content: ${action.path}`
        );
      }

      const normalizedPath =
        normalizeFrontendPath(
          action.path
        );

      results.push(
        updateFile(
          projectName,
          normalizedPath,
          action.content
        )
      );

      continue;
    }

    // --------------------------------------------------------
    // UNKNOWN ACTION
    // --------------------------------------------------------

    throw new Error(
      `Unsupported action: ${action.type}`
    );
  }

  console.log(
    `\n✅ Aura plan processed successfully.`
  );

  console.log(
    `📦 Project: ${projectName}`
  );

  console.log(
    `📍 Path: ${projectInfo.projectPath}`
  );

  return {
    success: true,
    projectName,
    projectPath:
      projectInfo.projectPath,
    results,
  };
}

// ============================================================
// EXECUTE GENERATED FILES
// ============================================================
//
// This function receives generated files from the AI.
//
// Example:
//
// {
//   path: "frontend/src/App.jsx",
//   content: "..."
// }
//
// The file is guaranteed to be saved under:
//
// project/frontend/src/App.jsx
//
// ============================================================

async function executeGeneratedFiles({
  projectName,
  files = [],
}) {
  if (!projectName) {
    throw new Error(
      "Project name is required."
    );
  }

  if (!Array.isArray(files)) {
    throw new Error(
      "Generated files must be an array."
    );
  }

  if (!projectExists(projectName)) {
    createProject(projectName);
  }

  const results = [];

  for (
    const file of files
  ) {
    if (!file) {
      continue;
    }

    if (
      typeof file.path !== "string"
    ) {
      throw new Error(
        "Generated file path is missing."
      );
    }

    if (
      typeof file.content !== "string"
    ) {
      throw new Error(
        `Generated content missing for: ${file.path}`
      );
    }

    results.push(
      saveGeneratedFile(
        projectName,
        file.path,
        file.content
      )
    );
  }

  return {
    success: true,
    projectName,
    files: results,
  };
}

// ============================================================
// EXECUTE FIX PLAN
// ============================================================

async function executeFixPlan(
  projectName,
  plan
) {
  if (!projectName) {
    throw new Error(
      "Project name is required for fix."
    );
  }

  if (
    !validateProjectName(projectName)
  ) {
    throw new Error(
      `Invalid project name: ${projectName}`
    );
  }

  if (
    !plan ||
    !Array.isArray(plan.actions)
  ) {
    throw new Error(
      "Invalid fix plan."
    );
  }

  if (
    !projectExists(projectName)
  ) {
    throw new Error(
      `Project does not exist: ${projectName}`
    );
  }

  const results = [];

  for (
    const action of plan.actions
  ) {
    if (!action) {
      continue;
    }

    // --------------------------------------------------------
    // UPDATE FILE
    // --------------------------------------------------------

    if (
      action.type === "update_file"
    ) {
      if (
        typeof action.content !== "string"
      ) {
        throw new Error(
          `Fix update_file requires content: ${action.path}`
        );
      }

      const normalizedPath =
        normalizeFrontendPath(
          action.path
        );

      results.push(
        updateFile(
          projectName,
          normalizedPath,
          action.content
        )
      );

      continue;
    }

    // --------------------------------------------------------
    // CREATE FILE
    // --------------------------------------------------------

    if (
      action.type === "create_file"
    ) {
      if (
        typeof action.content !== "string"
      ) {
        throw new Error(
          `Fix create_file requires content: ${action.path}`
        );
      }

      const normalizedPath =
        normalizeFrontendPath(
          action.path
        );

      results.push(
        createFile(
          projectName,
          normalizedPath,
          action.content
        )
      );

      continue;
    }

    throw new Error(
      `Unsupported fix action: ${action.type}`
    );
  }

  return {
    success: true,
    projectName,
    results,
  };
}

// ============================================================
// GET PROJECT FILES
// ============================================================

function getProjectFiles(
  projectName
) {
  if (
    !projectExists(projectName)
  ) {
    throw new Error(
      `Project does not exist: ${projectName}`
    );
  }

  const projectRoot =
    safeProjectPath(
      projectName
    );

  const files = [];

  function walk(currentDirectory) {
    const entries =
      fs.readdirSync(
        currentDirectory,
        {
          withFileTypes: true,
        }
      );

    for (
      const entry of entries
    ) {
      if (
        isDisallowedGeneratedFile(
          entry.name
        )
      ) {
        continue;
      }

      const fullPath =
        path.join(
          currentDirectory,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {
        walk(fullPath);
      } else {
        files.push(
          path
            .relative(
              projectRoot,
              fullPath
            )
            .replace(/\\/g, "/")
        );
      }
    }
  }

  walk(projectRoot);

  return files;
}

// ============================================================
// READ PROJECT FILE
// ============================================================

function readProjectFile(
  projectName,
  filePath
) {
  validateFilePath(filePath);

  const targetPath =
    safeProjectPath(
      projectName,
      filePath
    );

  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `File does not exist: ${filePath}`
    );
  }

  if (
    !fs.statSync(targetPath).isFile()
  ) {
    throw new Error(
      `Target is not a file: ${filePath}`
    );
  }

  return fs.readFileSync(
    targetPath,
    "utf8"
  );
}

// ============================================================
// DELETE PROJECT FILE
// ============================================================

function deleteProjectFile(
  projectName,
  filePath
) {
  validateFilePath(filePath);

  if (
    isDisallowedGeneratedFile(filePath)
  ) {
    throw new Error(
      `Environment or secret files are not allowed: ${filePath}`
    );
  }

  const targetPath =
    safeProjectPath(
      projectName,
      filePath
    );

  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `File does not exist: ${filePath}`
    );
  }

  if (
    !fs.statSync(targetPath).isFile()
  ) {
    throw new Error(
      `Target is not a file: ${filePath}`
    );
  }

  fs.unlinkSync(targetPath);

  console.log(
    `🗑️ Deleted: ${filePath}`
  );

  return {
    success: true,
    path: filePath,
  };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  executePlan,
  executeGeneratedFiles,
  executeFixPlan,

  createProject,
  projectExists,

  createFile,
  updateFile,
  saveGeneratedFile,
  readProjectFile,
  deleteProjectFile,
  getProjectFiles,

  validateProjectName,
  validateFilePath,
  safeProjectPath,

  // Expose this for agent.js verification/debugging
  normalizeFrontendPath,
};

