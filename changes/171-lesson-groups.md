Changed

Shipped lessons sit in numbered group folders, so the kit can hold any number of them within the 7-entry folder cap. `yokoten learn --ship <id>` puts a lesson in the first group with room (for example `kit/lessons/1/incident-138/`): the top folder holds the table and up to 6 groups, and a group holds up to 5 lessons and 2 more groups. The lessons table gets a "Folder" column, and `doctor` finds each lesson by it; a table row without a folder still reads as a flat lesson. "notNow" still takes the lesson's id, not its folder (#171).
