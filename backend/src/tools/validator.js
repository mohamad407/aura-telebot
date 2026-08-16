const fs = require("fs");
const path = require("path");

// ======================================================
// PROJECT ROOT
// ======================================================

const PROJECTS_ROOT = path.resolve(
  __dirname,
  "../projects"
);

// ======================================================
// HELPERS
// ======================================================

function getProjectPath(projectName) {
  if (!projectName || typeof projectName !== "string") {
    throw new Error("Invalid project name.");
  }

  const safeName = projectName
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-");

  const projectPath = path.resolve(
    PROJECTS_ROOT,
    safeName
  );

  // Security check
  if (
    !projectPath.startsWith(
      PROJECTS_ROOT + path.sep
    )
  ) {
    throw new Error("Invalid project path.");
  }

  return projectPath;
}

// ======================================================
// CHECK EXTERNAL RESOURCE
// ======================================================

function isExternalResource(resource) {
  if (!resource || typeof resource !== "string") {
    return false;
  }

  const value = resource.trim();

  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("//") ||
    value.startsWith("data:") ||
    value.startsWith("blob:")
  );
}

// ======================================================
// REMOVE QUERY / HASH
// ======================================================

function cleanResourcePath(resource) {
  if (!resource) {
    return "";
  }

  return resource
    .split("?")[0]
    .split("#")[0]
    .trim();
}

// ======================================================
// CHECK LOCAL FILE
// ======================================================

function checkLocalFile(
  projectPath,
  resourcePath
) {
  const cleanPath =
    cleanResourcePath(resourcePath);

  if (!cleanPath) {
    return true;
  }

  const normalized =
    cleanPath.replace(/\\/g, "/");

  const absolutePath = path.resolve(
    projectPath,
    normalized
  );

  // Prevent path traversal
  if (
    !absolutePath.startsWith(
      projectPath + path.sep
    ) &&
    absolutePath !== projectPath
  ) {
    return false;
  }

  return fs.existsSync(absolutePath);
}

// ======================================================
// HTML VALIDATION
// ======================================================

function validateHTML(
  projectPath,
  errors,
  warnings
) {
  const indexPath = path.join(
    projectPath,
    "index.html"
  );

  if (!fs.existsSync(indexPath)) {
    errors.push(
      "index.html is missing."
    );

    return;
  }

  let html;

  try {
    html = fs.readFileSync(
      indexPath,
      "utf8"
    );
  } catch (error) {
    errors.push(
      `index.html could not be read: ${error.message}`
    );

    return;
  }

  // ------------------------------------------
  // CSS <link>
  // ------------------------------------------

  const cssRegex =
    /<link\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let cssMatch;

  while (
    (cssMatch = cssRegex.exec(html)) !== null
  ) {
    const href = cssMatch[1];

    // IMPORTANT:
    // External CDN files are valid.
    if (isExternalResource(href)) {
      continue;
    }

    // Ignore special links
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    ) {
      continue;
    }

    if (
      !checkLocalFile(
        projectPath,
        href
      )
    ) {
      errors.push(
        `index.html: missing CSS file ${href}.`
      );
    }
  }

  // ------------------------------------------
  // JavaScript <script src="">
  // ------------------------------------------

  const scriptRegex =
    /<script\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let scriptMatch;

  while (
    (scriptMatch =
      scriptRegex.exec(html)) !== null
  ) {
    const src = scriptMatch[1];

    // IMPORTANT:
    // External CDN scripts are valid.
    if (isExternalResource(src)) {
      continue;
    }

    if (
      src.startsWith("#") ||
      src.startsWith("data:")
    ) {
      continue;
    }

    if (
      !checkLocalFile(
        projectPath,
        src
      )
    ) {
      errors.push(
        `index.html: missing JavaScript file ${src}.`
      );
    }
  }

  // ------------------------------------------
  // Basic HTML checks
  // ------------------------------------------

  if (
    !/<html[\s>]/i.test(html)
  ) {
    warnings.push(
      "index.html does not contain an <html> element."
    );
  }

  if (
    !/<head[\s>]/i.test(html)
  ) {
    warnings.push(
      "index.html does not contain a <head> element."
    );
  }

  if (
    !/<body[\s>]/i.test(html)
  ) {
    warnings.push(
      "index.html does not contain a <body> element."
    );
  }

  if (
    !/<meta[^>]+viewport/i.test(html)
  ) {
    warnings.push(
      "index.html is missing a responsive viewport meta tag."
    );
  }

  if (
    !/<title[\s>]/i.test(html)
  ) {
    warnings.push(
      "index.html is missing a <title> element."
    );
  }
}

// ======================================================
// CHECK COMMON PROJECT FILES
// ======================================================

function validateProjectFiles(
  projectPath,
  errors,
  warnings
) {
  const files = fs.readdirSync(
    projectPath,
    {
      withFileTypes: true,
    }
  );

  if (files.length === 0) {
    errors.push(
      "Project directory is empty."
    );

    return;
  }

  const hasHTML =
    files.some(
      (file) =>
        file.isFile() &&
        file.name.toLowerCase() ===
          "index.html"
    );

  const hasPackageJson =
    files.some(
      (file) =>
        file.isFile() &&
        file.name.toLowerCase() ===
          "package.json"
    );

  // Static websites normally need index.html.
  if (!hasHTML && !hasPackageJson) {
    warnings.push(
      "Project does not contain index.html or package.json."
    );
  }
}

// ======================================================
// PACKAGE.JSON VALIDATION
// ======================================================

function validatePackageJson(
  projectPath,
  errors,
  warnings
) {
  const packagePath = path.join(
    projectPath,
    "package.json"
  );

  if (!fs.existsSync(packagePath)) {
    return;
  }

  let packageJson;

  try {
    const content =
      fs.readFileSync(
        packagePath,
        "utf8"
      );

    packageJson =
      JSON.parse(content);
  } catch (error) {
    errors.push(
      `package.json is invalid JSON: ${error.message}`
    );

    return;
  }

  if (
    !packageJson.name
  ) {
    warnings.push(
      "package.json does not contain a name."
    );
  }

  if (
    packageJson.scripts &&
    typeof packageJson.scripts !==
      "object"
  ) {
    errors.push(
      "package.json scripts field is invalid."
    );
  }
}

// ======================================================
// PROJECT VALIDATOR
// ======================================================

function validateProject(
  projectName
) {
  const errors = [];
  const warnings = [];

  try {
    const projectPath =
      getProjectPath(projectName);

    console.log(
      `🔎 Validator inspecting: ${projectPath}`
    );

    // ------------------------------------------
    // Project exists?
    // ------------------------------------------

    if (
      !fs.existsSync(projectPath)
    ) {
      return {
        success: false,
        errors: [
          `Project does not exist: ${projectName}`,
        ],
        warnings: [],
      };
    }

    // ------------------------------------------
    // Project directory?
    // ------------------------------------------

    const stats =
      fs.statSync(projectPath);

    if (!stats.isDirectory()) {
      return {
        success: false,
        errors: [
          `${projectName} is not a directory.`,
        ],
        warnings: [],
      };
    }

    // ------------------------------------------
    // Validate files
    // ------------------------------------------

    validateProjectFiles(
      projectPath,
      errors,
      warnings
    );

    // ------------------------------------------
    // Validate HTML
    // ------------------------------------------

    validateHTML(
      projectPath,
      errors,
      warnings
    );

    // ------------------------------------------
    // Validate package.json
    // ------------------------------------------

    validatePackageJson(
      projectPath,
      errors,
      warnings
    );

    // ------------------------------------------
    // RESULT
    // ------------------------------------------

    return {
      success:
        errors.length === 0,

      errors,

      warnings,
    };
  } catch (error) {
    console.error(
      "❌ Validator error:",
      error
    );

    return {
      success: false,

      errors: [
        error.message ||
          "Unknown validation error.",
      ],

      warnings: [],
    };
  }
}

// ======================================================
// EXPORT
// ======================================================

module.exports = {
  validateProject,
};
