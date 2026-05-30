-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target_exam" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_courses" (
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_courses_pkey" PRIMARY KEY ("user_id","course_id")
);

-- CreateIndex
CREATE INDEX "courses_tenant_id_target_exam_idx" ON "courses"("tenant_id", "target_exam");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenant_id_name_key" ON "courses"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "teacher_courses_course_id_idx" ON "teacher_courses"("course_id");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_courses" ADD CONSTRAINT "teacher_courses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_courses" ADD CONSTRAINT "teacher_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

