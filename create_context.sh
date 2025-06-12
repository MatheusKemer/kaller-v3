# FILE: create_context.sh
# DESCRIPTION: This script finds all relevant project files and concatenates them into a single output file for context.

# Define the name of the output file.
OUTPUT_FILE="project_context.txt"

# Define directories and files to ignore.
# The .env file is excluded for security.
# The output file itself is excluded to avoid it being included in subsequent runs.
EXCLUDE_DIRS=("./node_modules/*" "./.git/*")
EXCLUDE_FILES=(".env" "call-gpt-main.zip" "$OUTPUT_FILE")

# Create or clear the output file to ensure it's empty before starting.
> "$OUTPUT_FILE"

# Create a string for find's -not -path option for directories
EXCLUDE_PATHS_STR=""
for dir in "${EXCLUDE_DIRS[@]}"; do
  EXCLUDE_PATHS_STR+=" -not -path \"$dir\""
done

# Create a string for find's -not -name option for files
EXCLUDE_NAMES_STR=""
for file in "${EXCLUDE_FILES[@]}"; do
  EXCLUDE_NAMES_STR+=" -not -name \"$file\""
done

# Use 'find' to locate all files, excluding the specified patterns.
# The 'eval' command is used here to correctly process the exclude strings.
# -print0 and 'while read -d' are used to handle filenames with spaces or special characters safely.
eval find . -type f $EXCLUDE_PATHS_STR $EXCLUDE_NAMES_STR -print0 | while IFS= read -r -d $'\0' file; do

  # Add a header with the file path to the output file.
  echo "====================================================================" >> "$OUTPUT_FILE"
  echo "### FILE: $file" >> "$OUTPUT_FILE"
  echo "====================================================================" >> "$OUTPUT_FILE"

  # Append the content of the current file to the output file.
  cat "$file" >> "$OUTPUT_FILE"

  # Add two newlines for better separation between file contents.
  echo -e "\n\n" >> "$OUTPUT_FILE"
done

# Inform the user that the script has finished.
echo "✅ Project context successfully created at: $OUTPUT_FILE"
echo "ℹ️  The .env file was successfully ignored."