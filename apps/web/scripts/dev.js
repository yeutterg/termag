// Keep Next's compiler cache between restarts. Deleting all of `.next` here
// forced every dev launch to rebuild the full module graph and drove the
// otherwise-idle server close to a gigabyte before the first edit.
require("../server");
