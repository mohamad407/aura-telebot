const fs = require("fs");
const path = require("path");

const PROJECTS_DIR = path.resolve(
  __dirname,
  "../projects"
);

function getProjectFiles(projectName) {
  const projectRoot = path.resolve(
    PROJECTS_DIR,
    projectName
  );

  if (!projectRoot.startsWith(PROJECTS_DIR)) {
    throw new Error("Unsafe project path.");
  }

  const files = [];

  function scan(directory) {
    const entries = fs.readdirSync(
      directory,
      { withFileTypes: true }
    );

    for (const entry of entries) {
      const fullPath = path.join(
        directory,
        entry.name
      );

      if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        const relativePath = path.relative(
          projectRoot,
          fullPath
        );

        if (
          relativePath !== ".env" &&
          !relativePath.endsWith(
            `${path.sep}.env`
          )
        ) {
          files.push({
            path: relativePath.replace(
              /\\/g,
              "/"
            ),
            content: fs.readFileSync(
              fullPath,
              "utf8"
            ),
          });
        }
      }
    }
  }

  scan(projectRoot);

  return files;
}

module.exports = {
  getProjectFiles,
};
