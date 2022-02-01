const cron = require("node-cron");
const fauna = require("faunadb");
const dotenv = require("dotenv");
const shared = require("./shared/utils.js");
dotenv.config();

const q = fauna.query;
const client = new fauna.Client({
    secret: process.env.FAUNA_SECRET,
});

cron.schedule(
    "30 9 * * *",
    () => {
        update();
    },
    {
        scheduled: true,
        timezone: "Asia/Bangkok",
    }
);

const update = async () => {
    // grab all funds
    let returnObjFaunaGetFunds;
    try {
        returnObjFaunaGetFunds = await client.query(
            q.Map(
                q.Paginate(q.Match(q.Index("all_funds"))),
                q.Lambda("x", q.Get(q.Var("x")))
            )
        );
    } catch (error) {
        console.log(error);
    }

    if (returnObjFaunaGetFunds.data.length !== 0) {
        for (let fund of returnObjFaunaGetFunds.data) {
            await shared.updateContract(fund);
        }
    }
};
