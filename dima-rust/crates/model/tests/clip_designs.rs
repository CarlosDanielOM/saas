//! Execute the document hooks as an ordered pair of real writes, including failure after reset.
mod support;
use anyhow::{Context, Result};
use bson::doc;
use dima_model::clipdesigns::{self, COLLECTION, INFO};
use dima_store::mongo::{WriteContext, save::Change};

#[tokio::test]
async fn hook_plans_execute_in_reference_order() -> Result<()> {
    support::with_store(|store| async move {
        let mut ctx = WriteContext::new(1_000);
        let peers = store.documents(COLLECTION);
        peers.insert_many([
            doc! {"name":"first", "channelID":"111", "channel":"seed", "cssUrl":"css", "isDefault":true},
            doc! {"name":"foreign", "channelID":"222", "channel":"seed", "cssUrl":"css", "isDefault":true},
        ]).await?;
        let plan = clipdesigns::prepare_create(&doc! {"name":"new", "channelID":"111", "channel":"seed", "cssUrl":"css", "isDefault":true, "updatedAt":bson::DateTime::from_millis(0)}, &mut ctx)?;
        assert_eq!(plan.insert.document.get_datetime("updatedAt")?.timestamp_millis(), 1_000);
        plan.execute(&store).await?;
        assert_eq!(peers.count_documents(doc! {"channelID":"111", "isDefault":true}).await?, 1);
        assert_eq!(peers.count_documents(doc! {"channelID":"222", "isDefault":true}).await?, 1);
        let loaded = INFO.load_for_save(&store, &doc! {"name":"first"}, &mut ctx).await?.context("first")?;
        let plan = clipdesigns::prepare_save(&loaded, &[Change::set("isDefault", true)], &mut ctx)?;
        plan.execute(&store).await?;
        assert!(peers.find_one(doc! {"name":"first", "isDefault":true}).await?.is_some());
        assert!(peers.find_one(doc! {"name":"new", "isDefault":false}).await?.is_some());
        // Build indexes only in this disposable database, then provoke the reference's
        // nontransactional failure: the hook runs before the insert fails on global name.
        dima_model::ensure_indexes(&store, &INFO, dima_model::IndexPolicy::BestEffort, std::time::Duration::from_secs(60)).await.require()?;
        let duplicate = clipdesigns::prepare_create(&doc! {"name":"first", "channelID":"111", "channel":"seed", "cssUrl":"css", "isDefault":true}, &mut ctx)?;
        assert!(duplicate.execute(&store).await.is_err());
        assert_eq!(peers.count_documents(doc! {"channelID":"111", "isDefault":true}).await?, 0);
        assert_eq!(peers.count_documents(doc! {"channelID":"222", "isDefault":true}).await?, 1);
        assert!(INFO.prepare_create(&doc! {}, &mut ctx).is_err());
        Ok(())
    }).await
}
