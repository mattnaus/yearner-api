const ApiError = require("./ApiError.js");

module.exports = function (err, req, res, next) {
    // do not do this in production! Use logging lib instead
    console.log(err);

    if (err instanceof ApiError) {
        res.status(err.code).json(err.message);
        return;
    }

    res.status(500).json("Something went wrong :(");
};
