import {
  validateRequestBody,
  projectSchema,
  agentTokenSchema,
  sshHostSchema,
} from "../validations";

describe("Validation Schemas", () => {
  describe("projectSchema", () => {
    it("should validate valid project data", () => {
      const validData = {
        name: "test-project",
        rootKey: "workstation",
        relativePath: "~/Projects/test",
        agentType: "shell",
        agentSpawnCommand: "/bin/bash",
        ctrlSpawnCommand: "/bin/zsh",
      };

      const result = validateRequestBody(projectSchema, validData);
      expect(result.name).toBe("test-project");
      expect(result.agentType).toBe("shell");
    });

    it("should reject invalid agent type", () => {
      const invalidData = {
        name: "test-project",
        rootKey: "workstation",
        relativePath: "~/Projects/test",
        agentType: "invalid-type",
      };

      expect(() => {
        validateRequestBody(projectSchema, invalidData);
      }).toThrow();
    });

    it("should reject empty project name", () => {
      const invalidData = {
        name: "",
        rootKey: "workstation",
        relativePath: "~/Projects/test",
        agentType: "shell",
      };

      expect(() => {
        validateRequestBody(projectSchema, invalidData);
      }).toThrow();
    });
  });

  describe("agentTokenSchema", () => {
    it("should validate valid agent token data", () => {
      const validData = {
        name: "my-laptop",
        color: "#ff0000",
        defaultRootKey: "workstation",
        defaultRelativePath: "~/Projects",
      };

      const result = validateRequestBody(agentTokenSchema, validData);
      expect(result.name).toBe("my-laptop");
      expect(result.color).toBe("#ff0000");
    });

    it("should reject invalid color format", () => {
      const invalidData = {
        name: "my-laptop",
        color: "invalid-color",
      };

      expect(() => {
        validateRequestBody(agentTokenSchema, invalidData);
      }).toThrow();
    });

    it("should accept data without optional fields", () => {
      const minimalData = {
        name: "my-laptop",
      };

      const result = validateRequestBody(agentTokenSchema, minimalData);
      expect(result.name).toBe("my-laptop");
      expect(result.color).toBeUndefined();
    });
  });

  describe("sshHostSchema", () => {
    it("should validate valid SSH host data", () => {
      const validData = {
        name: "production-server",
        host: "192.168.1.100",
        port: 22,
        user: "admin",
        color: "#00ff00",
      };

      const result = validateRequestBody(sshHostSchema, validData);
      expect(result.name).toBe("production-server");
      expect(result.port).toBe(22);
    });

    it("should reject invalid port number", () => {
      const invalidData = {
        name: "production-server",
        host: "192.168.1.100",
        port: 99999, // Invalid port
        user: "admin",
      };

      expect(() => {
        validateRequestBody(sshHostSchema, invalidData);
      }).toThrow();
    });

    it("should require port number", () => {
      const dataWithoutPort = {
        name: "production-server",
        host: "192.168.1.100",
        user: "admin",
      };

      // Port is required in the schema
      expect(() => {
        validateRequestBody(sshHostSchema, dataWithoutPort);
      }).toThrow();
    });
  });
});
